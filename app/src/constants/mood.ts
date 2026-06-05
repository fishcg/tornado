export const MOOD_MAP: Record<string, { label: string; color: string; emoji: string; negative?: boolean }> = {
  neutral:   { label: "平静",   color: "#888", emoji: "😐" },
  shy:       { label: "害羞",   color: "#e88", emoji: "😳" },
  annoyed:   { label: "不耐烦", color: "#e64", emoji: "😤", negative: true },
  soft:      { label: "温柔",   color: "#8be", emoji: "🥰" },
  flustered: { label: "慌乱",   color: "#eb8", emoji: "😰", negative: true },
  playful:   { label: "俏皮",   color: "#8e8", emoji: "😏" },
  cold:      { label: "冷淡",   color: "#68a", emoji: "🥶", negative: true },
  happy:     { label: "开心",   color: "#fc5", emoji: "😄" },
  angry:     { label: "生气",   color: "#c33", emoji: "😠", negative: true },
};

export function moodInfo(mood: string | null | undefined) {
  return (mood && MOOD_MAP[mood]) || MOOD_MAP.neutral;
}
