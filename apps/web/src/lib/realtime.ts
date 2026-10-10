/**
 * 快照 + SSE 实时同步：
 * 1. 先取带 seq 的全量快照，再订阅事件流；收到新序列的消息后重新拉取快照（服务端权威数据），忽略重复与旧序列。
 * 2. 同一页面内同一事件流只建一条 SSE 连接，所有组件共享（局域网 http 下浏览器对同一地址最多 6 条连接，
 *    多开页面时连接被长连接占满，普通请求会排队，表现为大屏「有时很快、有时要等」）。
 * 3. 页面转入后台 10 秒后释放连接，回到前台立即重连并补齐快照。
 * 4. 心跳 15 秒；超过 30 秒无心跳判定断线，有限退避重连（1/2/4/8/10 秒）；SSE 连续失败时降级为每 2 秒拉取快照。
 * 5. 服务端告知会话已失效（revoked）时不再重连，重新拉取快照以显示「需重新扫码/登录」。
 * localStorage 不保存任何竞标数据。
 */

import type { RealtimeMessage } from '@bidding/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from './api';

export type ConnState = 'connecting' | 'live' | 'reconnecting' | 'polling' | 'offline';

export interface RealtimeResult<T> {
  data: T | null;
  error: ApiError | null;
  conn: ConnState;
  /** 最近一次成功同步（快照或心跳）的本地时间 */
  lastSyncAt: number | null;
  reload: () => void;
}

const HEARTBEAT_TIMEOUT_MS = 30_000;
const POLL_MS = 2_000;
const BACKOFF = [1000, 2000, 4000, 8000, 10000];
const HIDDEN_RELEASE_MS = 10_000;

type StreamState = 'connecting' | 'live' | 'reconnecting' | 'failing' | 'offline' | 'suspended' | 'revoked';

interface StreamListener {
  onMessage(msg: RealtimeMessage): void;
  /** 连接（重新）建立：订阅方应补齐快照 */
  onHello(): void;
  onHeartbeat(): void;
  onResync(): void;
  onState(state: StreamState): void;
}

/** 一条共享的 SSE 连接 */
class SharedStream {
  private es: EventSource | null = null;
  private listeners = new Set<StreamListener>();
  private lastSeq = 0;
  private failures = 0;
  private state: StreamState = 'connecting';
  private hbTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private hiddenTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly url: string, private readonly onEmpty: () => void) {
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('online', this.onOnline);
  }

  attach(l: StreamListener, since: number): void {
    this.listeners.add(l);
    this.lastSeq = Math.max(this.lastSeq, since);
    if (!this.es && !this.reconnectTimer && this.state !== 'suspended') {
      this.open();
    } else {
      l.onState(this.state);
      // 加入已在运行的连接：期间可能已有消息推送给其他订阅方，立即补齐一次快照
      if (this.state === 'live') l.onHello();
    }
  }

  detach(l: StreamListener): void {
    this.listeners.delete(l);
    if (this.listeners.size > 0) return;
    this.close();
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('online', this.onOnline);
    this.onEmpty();
  }

  private setState(s: StreamState): void {
    this.state = s;
    for (const l of this.listeners) l.onState(s);
  }

  private open(): void {
    this.es?.close();
    const sep = this.url.includes('?') ? '&' : '?';
    const es = new EventSource(`${this.url}${sep}since=${this.lastSeq}`, { withCredentials: true });
    this.es = es;
    es.addEventListener('hello', () => {
      this.failures = 0;
      this.setState('live');
      this.armHeartbeat();
      for (const l of this.listeners) l.onHello();
    });
    es.addEventListener('heartbeat', (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data);
        if (typeof d.lastSeq === 'number') this.lastSeq = Math.max(this.lastSeq, d.lastSeq);
      } catch {
        // 忽略
      }
      this.armHeartbeat();
      for (const l of this.listeners) l.onHeartbeat();
    });
    es.addEventListener('resync', () => {
      this.lastSeq = 0;
      for (const l of this.listeners) l.onResync();
    });
    es.addEventListener('revoked', () => {
      this.close();
      this.setState('revoked');
      for (const l of this.listeners) l.onHello();
    });
    es.addEventListener('message', (ev) => {
      this.armHeartbeat();
      let msg: RealtimeMessage;
      try {
        msg = JSON.parse((ev as MessageEvent).data);
      } catch {
        return;
      }
      this.lastSeq = Math.max(this.lastSeq, msg.seq);
      for (const l of this.listeners) l.onMessage(msg);
    });
    es.onerror = () => {
      // 由我们控制退避，不使用浏览器默认的无限重试
      this.es?.close();
      this.es = null;
      this.failures++;
      this.setState(this.failures >= 3 ? 'failing' : 'reconnecting');
      this.scheduleReconnect();
    };
  }

  private armHeartbeat(): void {
    if (this.hbTimer) clearTimeout(this.hbTimer);
    this.hbTimer = setTimeout(() => {
      // 超过 30 秒无心跳：判定断线并重连
      this.es?.close();
      this.es = null;
      this.setState('offline');
      this.scheduleReconnect();
    }, HEARTBEAT_TIMEOUT_MS);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.state === 'suspended' || this.state === 'revoked') return;
    const delay = BACKOFF[Math.min(this.failures, BACKOFF.length - 1)];
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private close(): void {
    this.es?.close();
    this.es = null;
    if (this.hbTimer) clearTimeout(this.hbTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.hiddenTimer) clearTimeout(this.hiddenTimer);
    this.hbTimer = this.reconnectTimer = this.hiddenTimer = null;
  }

  /** 后台超过 10 秒释放连接；回到前台立即重连（hello 后各订阅方补齐快照） */
  private onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      if (!this.hiddenTimer) {
        this.hiddenTimer = setTimeout(() => {
          this.hiddenTimer = null;
          this.close();
          this.state = 'suspended';
        }, HIDDEN_RELEASE_MS);
      }
      return;
    }
    if (this.hiddenTimer) {
      clearTimeout(this.hiddenTimer);
      this.hiddenTimer = null;
    }
    if (this.state === 'suspended') {
      this.state = 'connecting';
      this.setState('reconnecting');
      this.open();
    }
  };

  private onOnline = () => {
    if (!this.es && this.state !== 'suspended' && this.state !== 'revoked') {
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.open();
    }
  };
}

const streams = new Map<string, SharedStream>();

function getStream(url: string): SharedStream {
  let s = streams.get(url);
  if (!s) {
    s = new SharedStream(url, () => streams.delete(url));
    streams.set(url, s);
  }
  return s;
}

export function useRealtime<T extends { seq: number }>(
  snapshotUrl: string | null,
  streamUrl: string | null,
  onMessage?: (msg: RealtimeMessage) => void,
): RealtimeResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [conn, setConn] = useState<ConnState>('connecting');
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const seqRef = useRef(0);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  const reloadRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!snapshotUrl || !streamUrl) return;
    let disposed = false;
    let streamState: StreamState = 'connecting';
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let loading: Promise<void> | null = null;
    let pendingReload = false;
    let snapshotOk = true;

    const deriveConn = (): ConnState => {
      if (!snapshotOk) return 'offline';
      switch (streamState) {
        case 'live':
          return 'live';
        case 'failing':
          return 'polling';
        case 'offline':
        case 'revoked':
          return 'offline';
        case 'reconnecting':
        case 'suspended':
          return 'reconnecting';
        default:
          return 'connecting';
      }
    };
    const refreshConn = () => !disposed && setConn(deriveConn());

    const loadSnapshot = async (): Promise<void> => {
      if (loading) {
        pendingReload = true;
        return loading;
      }
      loading = (async () => {
        try {
          const snap = await api.get<T>(snapshotUrl, { timeoutMs: 8000 });
          if (disposed) return;
          // 只接受不比当前更旧的快照
          if (snap.seq >= seqRef.current || seqRef.current === 0) {
            seqRef.current = snap.seq;
            setData(snap);
          }
          snapshotOk = true;
          setError(null);
          setLastSyncAt(Date.now());
          refreshConn();
        } catch (e) {
          if (disposed) return;
          // 拉取失败：即使推送通道仍在，也无法确认最新数据——明确显示断线，保留最后一次已确认数据，并定时重试
          snapshotOk = false;
          refreshConn();
          if (e instanceof ApiError && (e.status === 401 || e.status === 403 || e.status === 404)) {
            // 会话失效或无权访问：重试没有意义，交由页面提示重新扫码/登录
            setError(e);
            return;
          }
          if (!retryTimer) {
            retryTimer = setTimeout(() => {
              retryTimer = null;
              void loadSnapshot();
            }, 2000);
          }
        } finally {
          loading = null;
        }
      })();
      await loading;
      if (pendingReload && !disposed) {
        pendingReload = false;
        await loadSnapshot();
      }
    };
    reloadRef.current = () => void loadSnapshot();

    const startPolling = () => {
      if (!pollTimer) pollTimer = setInterval(() => void loadSnapshot(), POLL_MS);
    };
    const stopPolling = () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    };

    const listener: StreamListener = {
      onMessage: (msg) => {
        // 忽略重复与旧序列
        if (msg.seq <= seqRef.current) return;
        onMessageRef.current?.(msg);
        void loadSnapshot();
      },
      onHello: () => void loadSnapshot(),
      onHeartbeat: () => setLastSyncAt(Date.now()),
      onResync: () => {
        seqRef.current = 0;
        void loadSnapshot();
      },
      onState: (s) => {
        streamState = s;
        if (s === 'failing') startPolling();
        if (s === 'live') stopPolling();
        refreshConn();
      },
    };

    const stream = getStream(streamUrl);
    setConn('connecting');
    void loadSnapshot().then(() => {
      if (!disposed) stream.attach(listener, seqRef.current);
    });

    return () => {
      disposed = true;
      stream.detach(listener);
      if (retryTimer) clearTimeout(retryTimer);
      stopPolling();
    };
  }, [snapshotUrl, streamUrl]);

  const reload = useCallback(() => reloadRef.current(), []);
  return { data, error, conn, lastSyncAt, reload };
}

export const CONN_LABEL: Record<ConnState, string> = {
  connecting: '连接中',
  live: '实时同步',
  reconnecting: '重新连接中',
  polling: '降级刷新（每 2 秒）',
  offline: '连接中断，数据可能延迟',
};
