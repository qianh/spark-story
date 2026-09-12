import { formatChangePlan, readStoredPlan } from "../../packages/change-plan";

export function ChangePlanView({
  proposal,
  busy,
  onConfirm,
}: {
  proposal: string;
  busy: boolean;
  onConfirm: () => void;
}) {
  const plan = readStoredPlan(proposal);
  return (
    <div className="proposal">
      <small>主控评估</small>
      {plan ? (
        <pre className="change-plan">{formatChangePlan(plan)}</pre>
      ) : (
        <p>{proposal}</p>
      )}
      <button className="button primary" disabled={busy} onClick={onConfirm}>
        确认并执行
      </button>
    </div>
  );
}
