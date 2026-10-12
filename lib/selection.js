// Official modelSelection wire view is next/lastUsed; observeSession is read-only
// and covers live, detached history, format refusal and missing identities.
export async function currentSelection(ctx, sessionId, signal) {
  function checked(value) {
    if (!value || typeof value.provider !== 'string' || !value.provider.trim()) throw new Error('模型选择无效');
    return { provider: value.provider, model: value.model ?? null };
  }
  function defaultSelection() {
    const service = ctx.get('agentDefaultModel');
    if (!service || typeof service.currentSelection !== 'function') throw new Error('默认模型服务不可用');
    return checked(service.currentSelection());
  }
  // The route normalizes only an omitted identity to ''. Explicit invalid
  // request values are rejected there; the helper also refuses other types.
  if (sessionId === '' || sessionId === undefined) return defaultSelection();
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('会话身份无效');
  const query = ctx.get('sessionQuery');
  if (!query || typeof query.observeSession !== 'function') throw new Error('会话查询服务不可用，不能读取当前账号');
  const observation = await query.observeSession(String(sessionId), { signal });
  try {
    if (observation.header?.id !== String(sessionId)) throw new Error('会话身份不一致');
    const model = observation.projections?.values?.modelSelection;
    if (!model || !Object.hasOwn(model, 'next') || !Object.hasOwn(model, 'lastUsed')) throw new Error('会话模型投影不可用');
    const selection = model.next ?? model.lastUsed;
    return selection == null ? defaultSelection() : checked(selection);
  } finally {
    observation[Symbol.dispose]();
  }
}

export function sameSelection(left, right) {
  return left.provider === right.provider && left.model === right.model;
}

export function selectionConflict() {
  return Object.assign(new Error('当前模型已改变，请重新查询后操作'), { status: 409 });
}
