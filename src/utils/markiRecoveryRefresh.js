export function consumeMarkiRecoveryRefreshNonce(nextNonce, handledNonce = 0) {
  const next = Number(nextNonce);
  const handled = Number(handledNonce);
  const safeHandled = Number.isSafeInteger(handled) && handled >= 0 ? handled : 0;
  const shouldRefresh = Number.isSafeInteger(next) && next > safeHandled;
  return {
    shouldRefresh,
    handledNonce: shouldRefresh ? next : safeHandled
  };
}
