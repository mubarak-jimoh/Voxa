import { CompanionModeId, Memory, MemoryCategory, MemoryMood } from '../../types';
import { ExtractedMemoryCandidate } from '../contracts';
import { assessMemoryWrite, decisionToCandidate, MemoryWriteContext } from './memory-write-policy';
import { isDurableEnoughToStore } from './memory-quality';

type ExtractionRule = {
  category: MemoryCategory;
  keywords: string[];
  titleBuilder: (text: string) => string;
  importance: Memory['importance'];
  mood: MemoryMood;
  tags: string[];
};

const RULES: ExtractionRule[] = [
  {
    category: 'fitness',
    keywords: ['i box', 'boxing', 'times a week'],
    titleBuilder: () => 'Fitness habit',
    importance: 4,
    mood: 'motivated',
    tags: ['fitness', 'habit'],
  },
  {
    category: 'goals',
    keywords: ["i'm building", 'i am building', 'app called'],
    titleBuilder: () => 'Personal project',
    importance: 4,
    mood: 'motivated',
    tags: ['goals', 'project'],
  },
  {
    category: 'moments',
    keywords: ['driving test', 'my test is', "i've got my", 'interview is', 'exam is'],
    titleBuilder: (text) => (/\bdriving test\b/i.test(text) ? 'Driving test' : 'Upcoming event'),
    importance: 4,
    mood: 'motivated',
    tags: ['event'],
  },
  {
    category: 'future_plans',
    keywords: ['next month', 'next year', 'planning to', 'i will', "i'll", 'looking forward to'],
    titleBuilder: () => 'Future plan',
    importance: 4,
    mood: 'motivated',
    tags: ['plans'],
  },
  {
    category: 'routines',
    keywords: ['every morning', 'every evening', 'every day', 'daily routine', 'my routine'],
    titleBuilder: () => 'Daily routine',
    importance: 3,
    mood: 'calm',
    tags: ['routine'],
  },
  {
    category: 'habits',
    keywords: ['habit', 'usually i', 'i always', 'i tend to', 'i usually', 'from now on'],
    titleBuilder: () => 'Personal habit',
    importance: 3,
    mood: 'neutral',
    tags: ['habits'],
  },
  {
    category: 'fitness',
    keywords: ['switched to', "i've switched", 'i have switched', 'train after work', 'train in the morning'],
    titleBuilder: () => 'Training routine',
    importance: 3,
    mood: 'motivated',
    tags: ['fitness', 'routine'],
  },
  {
    category: 'study',
    keywords: ["i'm studying", 'i am studying', 'i study', "i'm working on", 'assignment due', 'exam is'],
    titleBuilder: () => 'Study context',
    importance: 3,
    mood: 'motivated',
    tags: ['study'],
  },
  {
    category: 'favourites',
    keywords: [
      'favorite',
      'favourite',
      'my favorite',
      'my favourite',
      'lucky number',
      'i support',
      'i love',
      'i adore',
    ],
    titleBuilder: (text) => (/\blucky number\b/i.test(text) ? 'Lucky number' : 'Favourite thing'),
    importance: 3,
    mood: 'joyful',
    tags: ['favourites'],
  },
  {
    category: 'preferences',
    keywords: [
      'i prefer',
      'i like',
      "i don't like",
      'i dislike',
      'i hate',
      'rather than',
      'short answers',
      'concise answers',
    ],
    titleBuilder: () => 'Preference',
    importance: 3,
    mood: 'neutral',
    tags: ['preferences'],
  },
  {
    category: 'people',
    keywords: [
      'my mom',
      'my mum',
      'my dad',
      'my sister',
      'my brother',
      'my partner',
      'my wife',
      'my husband',
      'my friend',
      "my dog's name",
      "my cat's name",
      'my pet',
      'my boss',
      'my colleague',
    ],
    titleBuilder: (text) => extractPersonTitle(text) ?? 'Important person',
    importance: 4,
    mood: 'warm',
    tags: ['people'],
  },
  {
    category: 'birthdays',
    keywords: ['birthday', 'born on', 'turns ', 'birth day'],
    titleBuilder: () => 'Birthday',
    importance: 5,
    mood: 'joyful',
    tags: ['birthday'],
  },
  {
    category: 'work',
    keywords: ['at work', 'my job', 'my office', 'my team at work', 'coworker', 'colleague'],
    titleBuilder: () => 'Work context',
    importance: 3,
    mood: 'neutral',
    tags: ['work'],
  },
  {
    category: 'study',
    keywords: ['school', 'class', 'exam', 'professor', 'homework', 'university', 'college'],
    titleBuilder: () => 'School & study',
    importance: 3,
    mood: 'motivated',
    tags: ['school'],
  },
  {
    category: 'fitness',
    keywords: ['workout', 'gym', 'running', 'exercise', 'training', 'lift weights'],
    titleBuilder: () => 'Fitness',
    importance: 3,
    mood: 'motivated',
    tags: ['fitness'],
  },
  {
    category: 'faith',
    keywords: ['church', 'mosque', 'prayer', 'faith', 'spiritual', 'worship'],
    titleBuilder: () => 'Faith & spirituality',
    importance: 4,
    mood: 'reflective',
    tags: ['faith'],
  },
  {
    category: 'fears',
    keywords: ['afraid of', 'scared of', 'anxious about', 'worried about', 'fear of'],
    titleBuilder: () => 'Fear or worry',
    importance: 4,
    mood: 'stressed',
    tags: ['fears'],
  },
  {
    category: 'emotional',
    keywords: ['i feel', "i'm feeling", 'stressed', 'overwhelmed', 'grateful', 'lonely'],
    titleBuilder: () => 'Emotional note',
    importance: 3,
    mood: 'reflective',
    tags: ['emotional'],
  },
];

function extractPersonTitle(text: string): string | null {
  const match = text.match(
    /\bmy\s+(mom|mum|dad|sister|brother|partner|wife|husband|friend|boss|colleague)\b/i,
  );
  if (!match) return null;
  const relation = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
  return `${relation}`;
}

function extractSentence(text: string, keywordIndex: number): string {
  const start = Math.max(0, text.lastIndexOf('.', keywordIndex) + 1, text.lastIndexOf('!', keywordIndex) + 1);
  const endCandidates = [
    text.indexOf('.', keywordIndex),
    text.indexOf('!', keywordIndex),
    text.indexOf('?', keywordIndex),
  ].filter((index) => index >= 0);
  const end = endCandidates.length > 0 ? Math.min(...endCandidates) + 1 : text.length;
  const snippet = text.slice(start, end).trim();
  return snippet.length > 12 ? snippet : text.trim().slice(0, 220);
}

export function extractMemoriesLocally(input: {
  userMessage: string;
  voxaReply: string;
  mode: CompanionModeId;
  existingMemories: Memory[];
  writeContext?: MemoryWriteContext;
}): ExtractedMemoryCandidate[] {
  const text = input.userMessage.trim();
  if (text.length < 8) return [];

  const lower = text.toLowerCase();
  if (!isDurableEnoughToStore(text) && !/\bremember (that|this)\b/i.test(lower)) return [];
  if (/^(lol|lmao|haha|just kidding|jk)\b/.test(lower)) return [];
  if (/^(yeah|yep|ok|okay|thanks|thank you|cool|nice)\b/.test(lower) && text.length < 40) return [];
  if (
    /\b(maybe|probably|might|perhaps|whatever|nevermind|never mind)\b/.test(lower) &&
    text.length < 40 &&
    !/\b(driving test|interview|exam|deadline|test is)\b/.test(lower)
  ) {
    return [];
  }

  const explicitDecision = assessMemoryWrite(text, input.writeContext);
  if (explicitDecision?.shouldPersist) {
    return [decisionToCandidate(explicitDecision)];
  }

  const candidates: ExtractedMemoryCandidate[] = [];
  const seen = new Set<string>();

  for (const rule of RULES) {
    const keyword = rule.keywords.find((item) => lower.includes(item));
    if (!keyword) continue;

    const fingerprint = `${rule.category}:${keyword}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);

    const keywordIndex = lower.indexOf(keyword);
    const content = extractSentence(text, keywordIndex);

    candidates.push({
      category: rule.category,
      title: rule.titleBuilder(text),
      content,
      importance: rule.importance,
      mood: rule.mood,
      tags: rule.tags,
      relatedMode: input.mode,
    });
  }

  return candidates.slice(0, 4);
}
