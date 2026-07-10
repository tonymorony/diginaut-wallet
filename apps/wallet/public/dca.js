// Dynamic Collateral Adjustment (#62): the node's getdcamultiplier reports the
// network-health multiplier as a JSON double (Core dca.cpp HEALTH_TIERS:
// 1.0 healthy / 1.25 warning / 1.5 critical / 2.0 emergency). digidollar-js
// takes basis points as BigInt — quoting collateral without this multiplier
// under-quotes on a degraded system and every mint gets rejected.

/** getdcamultiplier's double → exact BigInt basis points (1.25 → 12500n).
 * Bounded to [1, 10]: Core's tiers span 1.0–2.0, so anything outside means a
 * broken (or lying) node — fail loudly rather than quote from it. */
export function dcaBpsFromMultiplier(multiplier) {
  if (typeof multiplier !== 'number' || !Number.isFinite(multiplier) || multiplier < 1 || multiplier > 10) {
    throw new RangeError(`DCA multiplier must be a number in [1, 10], got ${multiplier}`);
  }
  return BigInt(Math.round(multiplier * 10_000));
}

/** Short quote annotation for a degraded system; null when healthy (1.0×). */
export function describeDca({ multiplier, tier_status } = {}) {
  const bps = dcaBpsFromMultiplier(multiplier);
  if (bps === 10_000n) return null;
  const factor = (Number(bps) / 10_000).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const tier = tier_status ? ` — network health: ${tier_status}` : '';
  return `${factor}× collateral${tier}`;
}
