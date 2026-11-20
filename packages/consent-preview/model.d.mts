export interface Selection {
  distance: boolean;
  routes: boolean;
  shoe: boolean;
}
export const initialSelection: Readonly<Selection>;
export function exampleValue(selection: Selection): string;
export function selectedCategories(selection: Selection): string[];
