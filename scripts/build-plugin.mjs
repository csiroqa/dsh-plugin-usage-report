/**
 * 外部 DSH 插件构建脚本（对应 harness 仓库内 tsdown.client.ts 的产物约定）
 *
 * 每个插件包按约定构建两个产物：
 *   - lib/index.js   host 半区（Node ESM；peer 依赖 @deepseek-ai/* 保持 external，
 *                     运行时由 dsh host 环境的模块解析提供）
 *   - lib/client.js  browser 半区（CJS + __ModuleLoader__.load 包装；平台模块
 *                     保持 external，其余全部内联；含 sourcemap）
 *
 * 用法：node scripts/build-plugin.mjs [--watch] [--only <pkg>]
 */
import { build, context } from 'esbuild'
import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 浏览器模块表（platform seed + 文档化的 runtime 例外），必须保持 external。 */
const CLIENT_EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

async function main() {
  const args = process.argv.slice(2)
  const watch = args.includes('--watch')
  const onlyIndex = args.indexOf('--only')
  const only = onlyIndex >= 0 ? args[onlyIndex + 1] : undefined

  const pluginRoots = await readdir(join(ROOT, 'plugins'))

  const pending = []
  for (const dir of pluginRoots) {
    if (only !== undefined && dir !== only) continue
    const pkgDir = join(ROOT, 'plugins', dir)
    const pkgPath = join(pkgDir, 'package.json')
    if (!existsSync(pkgPath)) continue
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
    const id = pkg.name

    const configs = []

    const hostEntry = join(pkgDir, 'src', 'index.ts')
    if (existsSync(hostEntry)) {
      configs.push({
        entryPoints: [hostEntry],
        outfile: join(pkgDir, 'lib', 'index.js'),
        format: 'esm',
        platform: 'node',
        target: 'es2024',
        bundle: true,
        sourcemap: true,
        external: ['@deepseek-ai/*'],
      })
    }

    const clientEntry = join(pkgDir, 'src', 'client', 'index.ts')
    if (existsSync(clientEntry)) {
      configs.push({
        entryPoints: [clientEntry],
        outfile: join(pkgDir, 'lib', 'client.js'),
        format: 'cjs',
        platform: 'browser',
        target: 'es2024',
        bundle: true,
        sourcemap: true,
        external: CLIENT_EXTERNALS,
        banner: {
          js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
        },
        footer: {
          js: 'return module.exports; } });',
        },
      })
    }

    for (const config of configs) {
      if (watch) {
        const ctx = await context(config)
        await ctx.watch()
        pending.push(ctx)
      } else {
        const result = await build(config)
        for (const warning of result.warnings) console.warn(warning.text)
        console.log(`[${id}] ${config.outfile} built`)
      }
    }
  }

  if (watch) {
    console.log('watching... (Ctrl+C to stop)')
    const stop = () => { for (const ctx of pending) void ctx.dispose() }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  } else if (pending.length > 0) {
    await Promise.all(pending.map(ctx => ctx.dispose()))
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})