// Stand-ins for the three specifiers the Desktop loader allows, so plugin.js can run under Node.
export const sdk = `
const atom = v => ({ get: () => v, subscribe: fn => { fn(v); return () => {} } })
export const host = { state: { focusedSessionId: atom(null), busyBySession: atom({}) } }
`
export const react = 'export const useState = v => [typeof v === "function" ? v() : v, () => {}]; export const useEffect = () => {}; export default {}'
export const jsxRuntime = 'export const jsx = (t, p) => ({ t, p }); export const jsxs = (t, p) => ({ t, p })'
