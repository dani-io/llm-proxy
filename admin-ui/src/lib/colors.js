// Categorical slots from the validated reference palette (light mode),
// assigned in fixed order. Colour follows the model's position in
// providers.yaml — never its rank in a chart — so a model keeps its colour
// across pages and ranges. Slots 3–5 sit below 3:1 contrast on white, so
// every chart is paired with a legend and the per-model table.
export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948']
export const OTHER = '#94a3b8'

export function colorMap(modelOrder) {
  const map = {}
  modelOrder.forEach((m, i) => {
    map[m] = i < SERIES.length ? SERIES[i] : OTHER
  })
  return map
}

export const GRID = '#e2e8f0'
export const AXIS_TEXT = '#64748b'
