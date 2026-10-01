// Where every "Open" goes: the ↗ on each card and the finished card's "Open
// terminal". Kept apart from island.ts, which builds DOM, so the unit tests can
// check that each button opens the session it sits on.

import { Bridge } from "../core/bridge";
import { State, isSession, type AgentTask } from "../core/state";

/** Same targets as openAgentTarget() on macOS. n8n opens the configured instance. */
export const INTEGRATION_URLS: Record<string, string> = {
  integration_resend: "https://resend.com/emails",
  integration_vercel: "https://vercel.com/dashboard",
  integration_github: "https://github.com",
  integration_stripe: "https://dashboard.stripe.com/payments",
  integration_notion: "https://notion.so",
  integration_calcom: "https://app.cal.com/bookings",
};

/** Opens a session (its terminal, or its folder) or an integration's page. */
export function openTask(task: AgentTask | null) {
  if (!task) return;
  if (isSession(task)) {
    void Bridge.openSession(task.cwd || null, task.wslDistro);
  } else if (task.id === "integration_n8n") {
    void Bridge.openN8n();
  } else if (INTEGRATION_URLS[task.id]) {
    void Bridge.openUrl(INTEGRATION_URLS[task.id]);
  }
}

/** ↗ on the left card. */
export const openPrimary = () => openTask(State.focusTask);

/** ↗ on the second session, top of the right card. */
export const openSecond = () => openTask(State.secondSession);

/** "Open terminal" on the finished card: the session that finished, whoever leads now. */
export const openSubject = () => openTask(State.subjectTask);
