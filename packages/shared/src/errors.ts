/** 统一业务错误码与手机端提示文案 */

export const ERROR_MESSAGES = {
  PROJECT_NOT_ACTIVE: '当前项目尚未开放',
  PROJECT_PAUSED: '竞标已暂停，请等待工作人员',
  PROJECT_LOCKED: '本项目已结束，不能追加',
  GROUP_NOT_OPEN: '尚未轮到本组，或本组已结束',
  BASE_NOT_ACKNOWLEDGED: '请先确认认领基础底标',
  INVALID_STEP: '追加后的增幅不符合规则',
  NOT_GREATER: '新增幅必须高于已确认增幅',
  NOT_LOWER: '更正后的增幅须低于当前增幅、且不低于首轮增幅',
  VERSION_CONFLICT: '当前增幅已更新，请重新确认',
  IDEMPOTENCY_CONFLICT: '请求标识冲突，请刷新并重新确认',
  SESSION_INVALID: '本机未登录或已下线（本单位可能已在另一部手机登录，或被工作人员下线）。请重新扫描本单位二维码进入。',
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
  PROJECT_ORDER: '须先锁定理财，才能开始基金竞标',
  ROUND1_INCOMPLETE: '首轮数据不完整，不能发布',
  CONFIG_INCOMPLETE: '活动配置不完整，不能正式开启竞标',
  ALREADY_ACKNOWLEDGED: '基础底标已确认',
  REASON_REQUIRED: '请填写原因',
  CONFIRM_REQUIRED: '重大操作需要二次确认',
  DEMO_ONLY: '仅演示活动允许该操作',
  GROUPS_NOT_FINISHED: '尚有分组未结束：正常锁定要求各组都已结束；确需提前收场，请勾选「提前收场」确认',
  KDOCS_INCOMPLETE: '金山表格没有全部读取成功，请核对后再操作',
  BAD_REQUEST: '请求格式不正确',
  READ_ONLY: '系统处于只读维护状态，暂停写入',
  CREDENTIAL_INVALID: '二维码已失效，请联系工作人员重新发放',
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
