import { Reminder } from '../../types';
import { nextFireDate, notificationService } from './notification-service';
import { LocalReminderScheduleResult } from './schedule-local-reminder-types';

export type { LocalReminderScheduleResult } from './schedule-local-reminder-types';
export { reminderScheduleConfirmation } from './reminder-schedule-copy';

export async function scheduleLocalReminderIfAllowed(
  reminder: Reminder,
): Promise<LocalReminderScheduleResult> {
  const granted = await notificationService.requestPermissions();
  if (!granted) return { ok: false, reason: 'permission_denied' };

  const fireAt = nextFireDate(reminder.scheduledAt, reminder.recurrence);
  if (reminder.recurrence === 'none' && fireAt.getTime() <= Date.now() - 5_000) {
    return { ok: false, reason: 'in_past' };
  }

  try {
    if (reminder.notificationId) {
      await notificationService.cancelNotification(reminder.notificationId).catch(() => undefined);
    }
    const notificationId = await notificationService.scheduleReminderFromEntity(reminder);
    return { ok: true, notificationId };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}
