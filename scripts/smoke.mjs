/**
 * CI 冒烟测试：加载 host 半区产物，校验导出形态（不启动 dsh）。
 * 依赖 harness host 半区已构建（@deepseek-ai/dsh-storage-domain 经 link 解析）。
 */
import { name, inject, apply } from '../plugins/usage-report/lib/index.js'

if (name !== 'usage-report') throw new Error(`unexpected plugin name: ${String(name)}`)
for (const key of ['commands', 'webServer', 'sessionPersistence', 'storageDomain']) {
  if (!inject.includes(key)) throw new Error(`missing inject: ${key}`)
}
if (typeof apply !== 'function') throw new Error('apply is not a function')
console.log(`[smoke] usage-report host bundle ok (name=${name}, inject=${inject.join(',')})`)
