import Svg, { Circle, Line, Path, Polygon, Polyline, Rect } from "react-native-svg";

type P = { size?: number; color?: string; strokeWidth?: number };

const def = (p: P) => ({
  width: p.size ?? 18,
  height: p.size ?? 18,
  stroke: p.color ?? "currentColor",
  strokeWidth: p.strokeWidth ?? 2,
  fill: "none",
});

export const IconBack = (p: P) => (
  <Svg viewBox="0 0 24 24" {...def(p)} strokeLinecap="round" strokeLinejoin="round">
    <Polyline points="15 18 9 12 15 6" />
  </Svg>
);

export const IconMore = (p: P) => (
  <Svg viewBox="0 0 24 24" {...def(p)} strokeLinecap="round" strokeLinejoin="round">
    <Circle cx="12" cy="5" r="1.6" fill={p.color ?? "currentColor"} />
    <Circle cx="12" cy="12" r="1.6" fill={p.color ?? "currentColor"} />
    <Circle cx="12" cy="19" r="1.6" fill={p.color ?? "currentColor"} />
  </Svg>
);

export const IconImage = (p: P) => (
  <Svg viewBox="0 0 24 24" {...def(p)} strokeLinecap="round" strokeLinejoin="round">
    <Rect x="3" y="3" width="18" height="18" rx="2" />
    <Circle cx="8.5" cy="8.5" r="1.5" />
    <Path d="m21 15-5-5L5 21" />
  </Svg>
);

export const IconScene = (p: P) => (
  <Svg viewBox="0 0 24 24" {...def(p)} strokeLinecap="round" strokeLinejoin="round">
    <Path d="M15 8h.01" />
    <Rect x="3" y="3" width="18" height="18" rx="2" />
    <Path d="m21 15-5-5L5 21" />
    <Circle cx="9" cy="9" r="2" />
  </Svg>
);

export const IconAuto = (p: P) => (
  <Svg viewBox="0 0 24 24" {...def(p)} strokeLinecap="round" strokeLinejoin="round">
    <Polygon points="5 3 19 12 5 21 5 3" />
  </Svg>
);

export const IconSemi = (p: P) => (
  <Svg viewBox="0 0 24 24" {...def(p)} strokeLinecap="round" strokeLinejoin="round">
    <Circle cx="12" cy="12" r="10" />
    <Polyline points="12 6 12 12 16 14" />
  </Svg>
);

export const IconStop = (p: P) => (
  <Svg viewBox="0 0 24 24" {...def(p)} strokeLinecap="round" strokeLinejoin="round">
    <Rect x="6" y="6" width="12" height="12" rx="1.5" />
  </Svg>
);

export const IconSend = (p: P) => (
  <Svg viewBox="0 0 24 24" {...def(p)} strokeWidth={p.strokeWidth ?? 2.5} strokeLinecap="round" strokeLinejoin="round">
    <Line x1="22" y1="2" x2="11" y2="13" />
    <Polygon points="22 2 15 22 11 13 2 9 22 2" />
  </Svg>
);

export const IconPlay = (p: P) => (
  <Svg viewBox="0 0 24 24" {...def(p)} strokeLinecap="round" strokeLinejoin="round">
    <Polygon points="6 4 20 12 6 20 6 4" fill={p.color ?? "currentColor"} />
  </Svg>
);

export const IconHeart = (p: P) => (
  <Svg viewBox="0 0 24 24" {...def(p)} strokeLinecap="round" strokeLinejoin="round">
    <Path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"
      fill={p.color ?? "currentColor"} stroke="none" />
  </Svg>
);

export const IconGallery = (p: P) => (
  <Svg viewBox="0 0 24 24" {...def(p)} strokeLinecap="round" strokeLinejoin="round">
    <Rect x="3" y="3" width="18" height="18" rx="2" />
    <Circle cx="8.5" cy="9" r="1.6" />
    <Path d="m21 16-4.5-4.5L9 19" />
    <Path d="M14 14l2-2 5 5" />
  </Svg>
);

export const IconSparkle = (p: P) => (
  <Svg viewBox="0 0 24 24" {...def(p)} strokeLinecap="round" strokeLinejoin="round">
    <Path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3z" />
    <Path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14z" />
  </Svg>
);

export const IconTrophy = (p: P) => (
  <Svg viewBox="0 0 24 24" {...def(p)} strokeLinecap="round" strokeLinejoin="round">
    <Path d="M8 21h8" />
    <Path d="M12 17v4" />
    <Path d="M7 4h10v5a5 5 0 0 1-10 0V4z" />
    <Path d="M17 5h2a2 2 0 0 1 2 2v1a3 3 0 0 1-3 3" />
    <Path d="M7 5H5a2 2 0 0 0-2 2v1a3 3 0 0 0 3 3" />
  </Svg>
);

export const IconPhone = (p: P) => (
  <Svg viewBox="0 0 24 24" {...def(p)} strokeLinecap="round" strokeLinejoin="round">
    <Path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.13 19.13 0 0 1 4.26 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.17 1h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L7.15 8.91a16 16 0 0 0 6.61 6.61l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
  </Svg>
);

export const IconChat = (p: P) => (
  <Svg viewBox="0 0 24 24" {...def(p)} strokeLinecap="round" strokeLinejoin="round">
    <Path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
  </Svg>
);

export const IconUser = (p: P) => (
  <Svg viewBox="0 0 24 24" {...def(p)} strokeLinecap="round" strokeLinejoin="round">
    <Path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <Circle cx="9" cy="7" r="4" />
    <Path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    <Path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </Svg>
);

export const IconSettings = (p: P) => (
  <Svg viewBox="0 0 24 24" {...def(p)} strokeLinecap="round" strokeLinejoin="round">
    <Circle cx="12" cy="12" r="3" />
    <Path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </Svg>
);

export const IconMe = (p: P) => (
  <Svg viewBox="0 0 24 24" {...def(p)} strokeLinecap="round" strokeLinejoin="round">
    <Circle cx="12" cy="8" r="4" />
    <Path d="M4 21a8 8 0 0 1 16 0" />
  </Svg>
);

export const IconBookmark = (p: P) => (
  <Svg viewBox="0 0 24 24" {...def(p)} strokeLinecap="round" strokeLinejoin="round">
    <Path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
  </Svg>
);
