// Visual tokens for the canvas. Chrome (HTML/CSS) uses the same values via css/app.css.
export const THEME = {
  bg: '#05070C',
  bg2: '#091321',
  surface: '#101E30',
  surfaceHi: '#16293F',
  border: '#203348',
  borderHi: '#2D4660',
  text: '#E5EDF5',
  text2: '#8D9FB4',
  text3: '#5C6F85',
  accent: '#5689BA',
  accentSoft: 'rgba(86,137,186,0.18)',
  grid: '#0F1B2B',
  danger: '#C0605E',
  font: '"Inter Variable", Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
};

// Muted, low-chroma palette: colour carries meaning, never decoration.
const PALETTE = {
  default: { stroke: '#2A4160', fill: '#101E30', text: '#E5EDF5', ink: '#8FB3D6' },
  blue: { stroke: '#3F6E9E', fill: '#12263D', text: '#E3EEF9', ink: '#7FB0E3' },
  teal: { stroke: '#34858C', fill: '#0F2B30', text: '#E0F1F2', ink: '#6FC3CB' },
  green: { stroke: '#3F7F5C', fill: '#112B20', text: '#E1F1E8', ink: '#74C69A' },
  yellow: { stroke: '#A68B3B', fill: '#2B2511', text: '#F5EDD2', ink: '#D9BE62' },
  orange: { stroke: '#B46D3B', fill: '#2F1E12', text: '#F6E6D8', ink: '#E39A62' },
  red: { stroke: '#B45150', fill: '#2E1718', text: '#F6DEDD', ink: '#E58583' },
  violet: { stroke: '#7D61B2', fill: '#201B35', text: '#EAE3F7', ink: '#AE97E0' },
  gray: { stroke: '#3B4B60', fill: '#0C1624', text: '#CBD6E2', ink: '#8D9FB4' },
};

export const colorOf = (name) => PALETTE[name] || PALETTE.default;
export const PALETTE_NAMES = Object.keys(PALETTE);

export const TAG_LABEL = { fact: 'FACT', suggestion: 'SUGGESTION', question: 'QUESTION' };
