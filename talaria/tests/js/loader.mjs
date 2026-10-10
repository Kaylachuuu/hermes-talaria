import { sdk, react, jsxRuntime } from './stubs.mjs'

const STUBS = { '@hermes/plugin-sdk': sdk, react, 'react/jsx-runtime': jsxRuntime }

export async function resolve(specifier, context, next) {
  if (specifier in STUBS) {
    return { shortCircuit: true, url: `talaria-stub:${specifier}` }
  }
  return next(specifier, context)
}

export async function load(url, context, next) {
  if (url.startsWith('talaria-stub:')) {
    return { format: 'module', shortCircuit: true, source: STUBS[url.slice('talaria-stub:'.length)] }
  }
  return next(url, context)
}
