export const initialSelection = Object.freeze({ distance: true, routes: true, shoe: true });

export function exampleValue(selection) {
  const cents = (selection.distance ? 90 : 0) + (selection.routes ? 70 : 0) + (selection.shoe ? 90 : 0);
  return (cents / 100).toFixed(2);
}

export function selectedCategories(selection) {
  return [
    selection.distance && 'Distance & pace',
    selection.routes && 'Exact map routes',
    selection.shoe && 'Shoe type'
  ].filter(Boolean);
}
