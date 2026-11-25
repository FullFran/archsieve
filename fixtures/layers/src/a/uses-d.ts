// Breaks the layering on purpose: a is the bottom layer and must not reach up to d.
import { top } from '../d/top';

export const usesTop = () => top;
