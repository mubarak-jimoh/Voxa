/** Restore the tray only when Talk rejected the send before consuming attachments. */
export function shouldRestorePendingAttachments(sendAccepted: boolean | void): boolean {
  return sendAccepted === false;
}
