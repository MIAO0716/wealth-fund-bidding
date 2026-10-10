/** 统一业务错误码与手机端提示文案 */

export const ERROR_MESSAGES = {
  PROJECT_NOT_ACTIVE: '当前项目尚未开放',
  PROJECT_PAUSED: '竞标已暂停，请等待工作人员',
  PROJECT_LOCKED: '本项目已结束，不能追加',
  GROUP_NOT_OPEN: '尚未轮到本组，或本组已结束',
  BASE_NOT_ACKNOWLEDGED: '请先确认认领基础底标',
  INVALID_STEP: '本次追加须为允许的5个百分点档位',
  NOT_GREATER: '新增幅必须高于已确认增幅',
  VERSION_CONFLICT: '当前增幅已更新，请重新确认',
  IDEMPOTENCY_CONFLICT: '请求标识冲突，请刷新并重新确认',
  SESSION_INVALID: '会话失效，请联系工作人员重新扫码',
  INVALID_VALUE: '提交的数值不合法',
  HIGH_VALUE_CONFIRM_REQUIRED: '增幅较大，请再次明确确认',
  NOT_FOUND: '记录不存在',
  FORBIDDEN: '无权执行该操作',
  UNAUTHORIZED: '请先登录',
  VALIDATION_FAILED: '数据校验未通过',
  VALIDATION_EXPIRED: '校验结果已失效，请重新校验',
  INVALID_STATE: '当前状态不允许该操作',
  CONTROL_VERSION_CONFLICT: '状态已被其他操作更新，请刷新后再试',
  DRAFT_VERSION_CONFLICT: '草稿已被修改，请重新校验',
  PROJECT_ORDER: '须先锁定理财，才能发布或开启基金',
  ROUND1_INCOMPLETE: '首轮数据不完整，不能发布',
  CONFIG_INCOMPLETE: '活动配置不完整，不能正式开启竞标',
  ALREADY_ACKNOWLEDGED: '基础底标已确认',
  REASON_REQUIRED: '请填写原因',
  CONFIRM_REQUIRED: '重大操作需要二次确认',
  DEMO_ONLY: '仅演示活动允许该操作',
  BAD_REQUEST: '请求格式不正确',
  READ_ONLY: '系统处于只读维护状态，暂停写入',
  CREDENTIAL_INVALID: '二维码已失效或已被使用，请联系工作人员重新发放',
  TOO_MANY_ATTEMPTS: '尝试次数过多，请稍后再试',
  INTERNAL: '服务器内部错误',
} as const;

export type ErrorCode = keyof typeof ERROR_MESSAGES;

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}
