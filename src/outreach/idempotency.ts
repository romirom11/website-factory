/** Stable outreach keys shared by decision services and delivery workers. */
export function sendIdempotencyKey(approvalId: number): string {
  return `send-outreach:approval:${approvalId}`;
}

export function followupIdempotencyKey(approvalId: number, index: number): string {
  return `followup:approval:${approvalId}:${index}`;
}
