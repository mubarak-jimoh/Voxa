export type LocalReminderScheduleResult =
  | { ok: true; notificationId: string }
  | { ok: false; reason: 'permission_denied' | 'in_past' | 'failed' };
