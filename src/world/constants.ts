/** Cells per chunk edge. Every chunk, regardless of LOD, is meshed from CHUNK^3 cells. */
export const CHUNK = 32;
/** Coarsest octree level. Level L chunks have voxels of size 2^L metres. */
export const MAX_LEVEL = 6;
export const ROOT_SIZE = CHUNK << MAX_LEVEL;
/** Indestructible floor of the world. */
export const BEDROCK = -470;
/** Nothing solid exists above this height (moonlets included). */
export const WORLD_TOP = 1150;
export const WORLD_BOTTOM = BEDROCK - 40;
