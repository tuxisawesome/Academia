/**
 * The letter of a keyboard shortcut such as Ctrl+C, lower-cased. Non-Latin layouts (Russian,
 * Greek, Hebrew, …) report their own character in `key`, so fall back to the physical key there;
 * Latin layouts such as AZERTY or Dvorak keep their own letters.
 */
export function shortcutKey(e: { key: string; code: string }): string {
  const key = e.key.toLowerCase();
  if (key.length !== 1 || (key >= "a" && key <= "z")) return key;
  const physical = /^Key([A-Z])$/.exec(e.code);
  return physical ? physical[1].toLowerCase() : key;
}

/**
 * True for keys that belong to an input method (Japanese, Chinese, Korean, …): the Enter that
 * accepts a conversion or the Esc that cancels it. Safari sends these after compositionend,
 * marked only by keyCode 229.
 */
export function isImeKey(e: { isComposing: boolean; keyCode: number }): boolean {
  return e.isComposing || e.keyCode === 229;
}
