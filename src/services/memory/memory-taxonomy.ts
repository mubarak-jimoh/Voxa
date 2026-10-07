import { Memory, MemoryCategory } from '../../types';

/** Semantic companion memory types — mapped onto persisted MemoryCategory values. */
export type CompanionMemoryType =
  | 'profile'
  | 'preference'
  | 'goal'
  | 'routine'
  | 'project'
  | 'person'
  | 'event'
  | 'decision'
  | 'experience'
  | 'conversational_preference';

export type MemoryImportanceLevel = 0 | 1 | 2 | 3 | 4 | 5;

export type MemoryConfidenceKind = 'explicit' | 'high' | 'medium' | 'low' | 'inferred';

export type MemorySemanticSlot =
  | 'training_routine'
  | 'study_routine'
  | 'food_preference'
  | 'communication_style'
  | 'work_project'
  | 'personal_goal'
  | 'person_reference'
  | 'upcoming_event'
  | 'general_preference'
  | 'general';

export const MEMORY_TYPE_TO_CATEGORY: Record<CompanionMemoryType, MemoryCategory[]> = {
  profile: ['preferences', 'work', 'study'],
  preference: ['preferences', 'favourites'],
  goal: ['goals', 'future_plans'],
  routine: ['routines', 'habits', 'fitness'],
  project: ['productivity', 'business', 'study', 'work'],
  person: ['people', 'birthdays'],
  event: ['moments', 'future_plans', 'work', 'study'],
  decision: ['moments', 'goals'],
  experience: ['moments', 'emotional'],
  conversational_preference: ['preferences'],
};

export const TRANSIENT_IMPORTANCE_THRESHOLD = 1;
export const PERSISTENT_IMPORTANCE_THRESHOLD = 2;

export const TAG_EXPLICIT = 'explicit';
export const TAG_INFERRED = 'inferred';
export const TAG_SUPERSEDED = 'superseded';
export const TAG_OPEN_LOOP = 'open_loop';
export const TAG_RESOLVED = 'resolved';
export const TAG_CANCELLED = 'cancelled';

export function resolveCompanionMemoryType(category: MemoryCategory, tags: string[] = []): CompanionMemoryType {
  if (tags.includes('conversational_preference')) return 'conversational_preference';
  for (const [type, categories] of Object.entries(MEMORY_TYPE_TO_CATEGORY) as Array<
    [CompanionMemoryType, MemoryCategory[]]
  >) {
    if (categories.includes(category)) return type;
  }
  return 'experience';
}

export function memoryTags(memory: Pick<Memory, 'tags'>): string[] {
  return Array.isArray(memory.tags) ? memory.tags : [];
}

export function isSupersededMemory(memory: Memory): boolean {
  return memoryTags(memory).includes(TAG_SUPERSEDED);
}

export function memoryConfidenceKind(memory: Memory): MemoryConfidenceKind {
  const tags = memoryTags(memory);
  if (tags.includes(TAG_INFERRED)) return 'inferred';
  if (tags.includes(TAG_EXPLICIT)) return 'explicit';
  const score = memory.confidence ?? 0.72;
  if (score >= 0.85) return 'high';
  if (score >= 0.6) return 'medium';
  return 'low';
}

export function confidenceKindForPrompt(kind: MemoryConfidenceKind): string {
  switch (kind) {
    case 'explicit':
      return 'known';
    case 'high':
      return 'known';
    case 'medium':
      return 'likely';
    case 'low':
      return 'uncertain';
    case 'inferred':
      return 'inferred — do not state as fact';
  }
}

export function inferSemanticSlot(category: MemoryCategory, content: string): MemorySemanticSlot {
  const lower = content.toLowerCase();
  if (category === 'fitness' || /\b(train(?:ing|s|ed)?|gym|workout|exercise)\b/.test(lower)) {
    return 'training_routine';
  }
  if (category === 'routines' || category === 'habits') {
    if (/\b(study|studying|school|exam|assignment)\b/.test(lower)) return 'study_routine';
    if (/\b(train(?:ing|s|ed)?|gym|workout)\b/.test(lower)) return 'training_routine';
  }
  if (category === 'preferences' || category === 'favourites') {
    if (/\b(food|eat|coffee|meal)\b/.test(lower)) return 'food_preference';
    if (/\b(concise|short answer|formal|casual)\b/.test(lower)) return 'communication_style';
    return 'general_preference';
  }
  if (category === 'goals' || category === 'future_plans') return 'personal_goal';
  if (category === 'people') return 'person_reference';
  if (category === 'moments' && /\b(tomorrow|today|tonight|next week|this weekend|interview|exam|deadline|driving test|friday|monday|tuesday|wednesday|thursday|saturday|sunday)\b/.test(lower)) {
    return 'upcoming_event';
  }
  if (category === 'productivity' || category === 'business' || category === 'work') {
    return 'work_project';
  }
  return 'general';
}

export function importanceFromLevel(level: MemoryImportanceLevel): Memory['importance'] {
  if (level <= 0) return 1;
  return Math.min(5, level) as Memory['importance'];
}
