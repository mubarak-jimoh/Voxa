import { LocalReminderScheduleResult } from './schedule-local-reminder-types';

export function reminderScheduleConfirmation(input: {
  title: string;
  when: string;
  scheduled: LocalReminderScheduleResult;
}): { success: boolean; confirmationMessage: string } {
  if (input.scheduled.ok) {
    return {
      success: true,
      confirmationMessage: `Done — I'll remind you to ${input.title.toLowerCase()} at ${input.when}.`,
    };
  }
  if (input.scheduled.reason === 'permission_denied') {
    return {
      success: false,
      confirmationMessage: `I saved "${input.title}" for ${input.when}, but notifications are off. Enable them in iOS Settings to get the reminder.`,
    };
  }
  if (input.scheduled.reason === 'in_past') {
    return {
      success: false,
      confirmationMessage: `That time has already passed, so I didn't schedule a notification.`,
    };
  }
  return {
    success: false,
    confirmationMessage: `I saved "${input.title}" for ${input.when}, but couldn't schedule a notification.`,
  };
}
