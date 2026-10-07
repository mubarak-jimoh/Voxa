const EPHEMERAL = [
  /^(lol|lmao|haha|jk|yeah|yep|ok|okay|thanks|cool|nice|sure|nah)\b/i,
  /\b(i('m| am)? (so |really )?(tired|sleepy|exhausted|hungry|bored|cold|hot))\b/i,
  /\b(what's the weather|what is the weather|weather today)\b/i,
  /^\s*\d+\s*[x×*]\s*\d+\s*$/i,
  /\b(right now|at the moment)\b.{0,20}\b(eating|ate|watching)\b/i,
];

const DURABLE_HINT =
  /\b(prefer|usually|always|every|sister|brother|building|app called|driving test|interview|exam|deadline|times a week|from now on|remember|lucky number|favourite|favorite|i support|i study|dog's name|cat's name)\b/i;

export function isEphemeralChatter(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 8) return true;
  if (DURABLE_HINT.test(trimmed)) return false;
  return EPHEMERAL.some((pattern) => pattern.test(trimmed));
}

export function isDurableEnoughToStore(text: string): boolean {
  if (isEphemeralChatter(text)) return false;
  const trimmed = text.trim();
  if (/^\d+([.,]\d+)?$/.test(trimmed)) return false;
  return true;
}
