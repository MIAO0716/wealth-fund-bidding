/**
 * 快照 + SSE 实时同步：
 * 1. 先取带 seq 的全量快照，再以 since=seq 订阅事件流，避免快照与订阅之间漏消息。
 * 2. 收到新序列的消息后重新拉取快照（服务端权威数据），忽略重复与旧序列。
 * 3. 心跳 15 秒；超过 30 秒无心跳判定断线，有限退避重连（1/2/4/8/10 秒）。
 * 4. SSE 连续失败时降级为每 2 秒拉取快照，并继续尝试恢复 SSE。
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
    let es: EventSource | null = null;
    let failures = 0;
    let hbTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let loading: Promise<void> | null = null;
    let pendingReload = false;
    // SSE 是否处于正常推送状态
    let esLive = false;
    let everLive = false;
    // 快照拉取失败后的重试
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

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
          setError(null);
          setLastSyncAt(Date.now());
          setConn(esLive ? 'live' : pollTimer ? 'polling' : everLive ? 'reconnecting' : 'connecting');
        } catch (e) {
          if (disposed) return;
          // 拉取失败：即使推送通道仍在，也无法确认最新数据——明确显示断线，保留最后一次已确认数据，并定时重试
          setConn('offline');
          if (!retryTimer) {
            retryTimer = setTimeout(() => {
              retryTimer = null;
              void loadSnapshot();
            }, 2000);
          }
          if (e instanceof ApiError && (e.status === 401 || e.status === 403 || e.status === 404)) setError(e);
          throw e;
        } finally {
          loading = null;
        }
      })();
      await loading.catch(() => {});
      if (pendingReload && !disposed) {
        pendingReload = false;
        await loadSnapshot();
      }
    };
    reloadRef.current = () => void loadSnapshot();

    const armHeartbeat = () => {
      if (hbTimer) clearTimeout(hbTimer);
      hbTimer = setTimeout(() => {
        // 超过 30 秒无心跳：判定断线并重连
        esLive = false;
        setConn('offline');
        reconnect();
      }, HEARTBEAT_TIMEOUT_MS);
    };

    const startPolling = () => {
      if (pollTimer) return;
      setConn('polling');
      pollTimer = setInterval(() => void loadSnapshot(), POLL_MS);
    };
    const stopPolling = () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    };

    const open = () => {
      if (disposed) return;
      es?.close();
      const sep = streamUrl.includes('?') ? '&' : '?';
      es = new EventSource(`${streamUrl}${sep}since=${seqRef.current}`, { withCredentials: true });
      es.addEventListener('hello', () => {
        esLive = true;
        everLive = true;
        failures = 0;
        stopPolling();
        setConn('live');
        setLastSyncAt(Date.now());
        armHeartbeat();
      });
      es.addEventListener('heartbeat', () => {
        setLastSyncAt(Date.now());
        armHeartbeat();
      });
      es.addEventListener('resync', () => {
        seqRef.current = 0;
        void loadSnapshot();
      });
      es.addEventListener('message', (ev) => {
        armHeartbeat();
        let msg: RealtimeMessage;
        try {
          msg = JSON.parse((ev as MessageEvent).data);
        } catch {
          return;
        }
        // 忽略重复与旧序列
        if (msg.seq <= seqRef.current) return;
        onMessageRef.current?.(msg);
        void loadSnapshot();
      });
      es.onerror = () => {
        // 由我们控制退避，不使用浏览器默认的无限重试
        es?.close();
        es = null;
        esLive = false;
        failures++;
        if (failures >= 3) startPolling();
        else setConn('reconnecting');
        reconnect();
      };
    };

    const reconnect = () => {
      if (disposed || reconnectTimer) return;
      es?.close();
      es = null;
      const delay = BACKOFF[Math.min(failures, BACKOFF.length - 1)];
      reconnectTimer = setTimeout(async () => {
        reconnectTimer = null;
        // 先补齐快照，再从最新序列订阅
        await loadSnapshot();
        open();
      }, delay);
    };

    setConn('connecting');
    void loadSnapshot().then(open);

    const onVisible = () => {
      if (document.visibilityState === 'visible') void loadSnapshot();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);

    return () => {
      disposed = true;
      es?.close();
      if (hbTimer) clearTimeout(hbTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (retryTimer) clearTimeout(retryTimer);
      stopPolling();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
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
