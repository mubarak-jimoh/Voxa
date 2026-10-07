import { createUuid } from '../../types';
import { ResponseBlock, ResponseBlockKind, RichReplyPayload } from '../../types/phase6-premium';

export function parseRichResponse(text: string, memoryTitles: string[] = []): RichReplyPayload {
  const blocks: ResponseBlock[] = [];
  const followUpChips: string[] = [];
  const suggestedActions: string[] = [];

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  const checklistItems = lines.filter((l) => /^[-•*]\s/.test(l) || /^\d+\.\s/.test(l)).map((l) => l.replace(/^[-•*\d.]+\s*/, ''));
  if (checklistItems.length >= 2 && checklistItems.length <= 8) {
    blocks.push({ id: createUuid(), kind: 'checklist', title: 'Steps', items: checklistItems });
  }

  const pros: string[] = [];
  const cons: string[] = [];
  let inPros = false;
  let inCons = false;
  for (const line of lines) {
    if (/^pros?:/i.test(line)) { inPros = true; inCons = false; continue; }
    if (/^cons?:/i.test(line)) { inCons = true; inPros = false; continue; }
    if (inPros && line.length > 3) pros.push(line.replace(/^[-•]\s*/, ''));
    if (inCons && line.length > 3) cons.push(line.replace(/^[-•]\s*/, ''));
  }
  if (pros.length > 0 || cons.length > 0) {
    blocks.push({ id: createUuid(), kind: 'pros_cons', title: 'Pros and cons', pros, cons });
  }

  if (/caution|warning|important:|seek professional|not a substitute/i.test(text)) {
    const cautionLine = lines.find((l) => /caution|warning|important/i.test(l)) ?? 'Take care with high-stakes decisions.';
    blocks.push({ id: createUuid(), kind: 'caution', body: cautionLine });
  }

  // Do not auto-attach a Summary card that repeats the visible reply.

  if (/\bstep\s*1\b/i.test(text) && checklistItems.length === 0) {
    const steps = lines.filter((l) => /^\s*step\s*\d/i.test(l) && l.length > 10).slice(0, 5);
    if (steps.length >= 2) blocks.push({ id: createUuid(), kind: 'steps', title: 'Plan', items: steps });
  }

  const timelineItems = lines.filter((l) => /^(week|day|month|phase)\s*\d|^\d{4}|^Q[1-4]/i.test(l));
  if (timelineItems.length >= 2) {
    blocks.push({ id: createUuid(), kind: 'timeline', title: 'Timeline', items: timelineItems.slice(0, 6) });
  }

  const tableRows = lines.filter((l) => l.includes('|') && l.split('|').length >= 2);
  if (tableRows.length >= 2) {
    blocks.push({ id: createUuid(), kind: 'table', title: 'Overview', items: tableRows.slice(0, 6) });
  }

  if (/reflect on|looking back|what you learned/i.test(text)) {
    blocks.push({ id: createUuid(), kind: 'reflection_card', body: 'A moment worth sitting with.' });
  }

  if (/action:|next step:|do this:/i.test(text)) {
    const actionLine = lines.find((l) => /action:|next step:|do this:/i.test(l));
    if (actionLine) blocks.push({ id: createUuid(), kind: 'action_card', body: actionLine });
  }

  const memoryMatch = memoryTitles.find((t) => text.toLowerCase().includes(t.toLowerCase().slice(0, 12)));
  if (memoryMatch) {
    blocks.push({ id: createUuid(), kind: 'memory_callback', body: `Connected to: ${memoryMatch}` });
  }

  if (/goal|achieve|working toward/i.test(text)) {
    suggestedActions.push('Turn into goal');
    followUpChips.push('Create a goal for this');
  }
  if (/routine|daily|habit/i.test(text)) {
    suggestedActions.push('Turn into routine');
    followUpChips.push('Add to my routine');
  }
  if (/\?/.test(text.split('\n').pop() ?? '')) {
    followUpChips.push('Tell me more');
  }

  return {
    text,
    blocks: blocks.slice(0, 4),
    suggestedActions: suggestedActions.slice(0, 3),
    relevantMemoryIds: [],
    followUpChips: followUpChips.slice(0, 4),
  };
}

export function blockKindLabel(kind: ResponseBlockKind): string {
  const labels: Record<ResponseBlockKind, string> = {
    summary: 'Summary',
    checklist: 'Checklist',
    steps: 'Steps',
    pros_cons: 'Pros & cons',
    timeline: 'Timeline',
    routine_suggestion: 'Routine',
    goal_proposal: 'Goal',
    decision_comparison: 'Compare',
    progress_update: 'Progress',
    memory_callback: 'Memory',
    caution: 'Note',
    quote: 'Quote',
    sports_result: 'Sports',
    expandable: 'Details',
    table: 'Table',
    action_card: 'Action',
    reflection_card: 'Reflection',
  };
  return labels[kind] ?? 'Details';
}
