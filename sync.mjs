import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const dataDir = resolve(root, 'data')
const stateDir = resolve(root, 'state')
const snapshotPath = resolve(dataDir, 'latest.json')
const reviewPath = resolve(dataDir, 'pending-review.json')
const statePath = resolve(stateDir, 'source-state.json')
const MAX_RATE = 1_000_000
const AUTO_CHANGE_LIMIT = 0.5
const TIMEOUT_MS = 20_000

export const sources = [
  { id: 'qwen-pricing', provider: '阿里云·通义千问', url: 'https://help.aliyun.com/en/model-studio/model-pricing', parser: 'qwen' },
  { id: 'deepseek-pricing', provider: 'DeepSeek', url: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/', parser: 'deepseek' },
  { id: 'doubao-pricing', provider: '火山引擎·豆包', url: 'https://docs.volcengine.com/docs/ark/model-pricing?lang=zh', parser: 'watch' },
  { id: 'glm-pricing', provider: '智谱 AI · GLM', url: 'https://open.bigmodel.cn/pricing', parser: 'watch' },
  { id: 'kimi-models-pricing', provider: '月之暗面·Kimi', url: 'https://platform.kimi.com/', parser: 'kimi' },
  { id: 'minimax-pricing', provider: 'MiniMax', url: 'https://platform.minimax.io/subscribe/token-plan', parser: 'watch' },
  { id: 'baidu-qianfan-pricing', provider: '百度·文心', url: 'https://cloud.baidu.com/product-s/qianfan_home', parser: 'baidu' },
  { id: 'tencent-hunyuan-pricing', provider: '腾讯·混元', url: 'https://cloud.tencent.com/document/product/1729/97731', parser: 'tencent' },
]

export function stripHtml(input) {
  return input.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&yen;|&#165;|&#xA5;/gi, '¥')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ').trim()
}

function candidate(modelId, input, output, cached, currency, source, detail, planId = null) {
  return { modelId, planId, inputPerMillion: input, outputPerMillion: output, cachedPerMillion: cached, currency, unit: 'per_1m_tokens', source, evidence: detail }
}

export function parseSource(source, body) {
  const text = stripHtml(body)
  if (source.parser === 'qwen') {
    const start = text.indexOf('qwen-max')
    if (start < 0) throw new Error('官方价格页未找到 qwen-max 型号行')
    const context = text.slice(start, start + 700)
    const match = context.match(/qwen-max[\s\S]{0,350}?CNY\s*([\d.]+)\s*CNY\s*([\d.]+)[\s\S]{0,120}?1 million tokens/i)
    if (!match) throw new Error('qwen-max 官方价格行无法无歧义解析')
    return [candidate('qwen-max', Number(match[1]), Number(match[2]), null, 'CNY', source.url, match[0])]
  }
  if (source.parser === 'deepseek') {
    const rates = text.match(/百万\s*tokens\s*输入\s*（缓存命中）\s*空闲时段\s*([\d.]+)\s*元\s*([\d.]+)\s*元\s*高峰时段\s*([\d.]+)\s*元\s*([\d.]+)\s*元\s*百万\s*tokens\s*输入\s*（缓存未命中）\s*空闲时段\s*([\d.]+)\s*元\s*([\d.]+)\s*元\s*高峰时段\s*([\d.]+)\s*元\s*([\d.]+)\s*元\s*百万\s*tokens\s*输出\s*空闲时段\s*([\d.]+)\s*元\s*([\d.]+)\s*元\s*高峰时段\s*([\d.]+)\s*元\s*([\d.]+)\s*元/i)
    if (!text.includes('deepseek-flash') || !rates) throw new Error('官方价格页未找到 Flash 的完整输入缓存/未命中及输出费率表')
    const offPeakRates = [Number(rates[1]), Number(rates[5]), Number(rates[9])]
    const peakRates = [Number(rates[3]), Number(rates[7]), Number(rates[11])]
    const proOffPeak = [Number(rates[2]), Number(rates[6]), Number(rates[10])]
    const proPeak = [Number(rates[4]), Number(rates[8]), Number(rates[12])]
    return [
      ['deepseek-flash', 'off-peak', offPeakRates], ['deepseek-flash', 'peak', peakRates],
      ['deepseek-v4-pro', 'off-peak', proOffPeak], ['deepseek-v4-pro', 'peak', proPeak],
    ].map(([modelId, planId, values]) => candidate(modelId, values[1], values[2], values[0], 'CNY', source.url,
      `${planId === 'peak' ? '高峰' : '空闲'}：缓存命中 ${values[0]}，未命中 ${values[1]}，输出 ${values[2]} 元/百万 tokens`, planId))
  }
  if (source.parser === 'baidu') {
    const start = text.indexOf('ernie-4.5-turbo-128k')
    if (start < 0) throw new Error('官方页面未找到预期 API 模型 ID')
    const context = text.slice(start, start + 700)
    const match = context.match(/输入价格\s*¥?\s*([\d.]+)\s*\/\s*千tokens[\s\S]{0,100}?输出价格\s*¥?\s*([\d.]+)\s*\/\s*千tokens/i)
    if (!match) throw new Error('模型 ID 存在，但输入/输出价格格式无法无歧义解析')
    return [candidate('ernie-4.5-turbo-128k', Number(match[1]) * 1000, Number(match[2]) * 1000, null, 'CNY', source.url, match[0])]
  }
  if (source.parser === 'tencent') {
    const match = text.match(/Hunyuan-a13b\s*(?:[|｜]\s*)?输入\s*[：:]\s*([\d.]+)\s*元\s*输出\s*[：:]\s*([\d.]+)\s*元/i)
    if (!match) throw new Error('官方计费表未找到 Hunyuan-a13b 的明确费率行')
    return [candidate('hunyuan-a13b', Number(match[1]), Number(match[2]), null, 'CNY', source.url, match[0])]
  }
  if (source.parser === 'kimi') {
    const start = text.indexOf('K3 Kimi K3')
    if (start < 0) throw new Error('官方主页未找到 Kimi K3 型号卡片')
    const context = text.slice(start, start + 500)
    const match = context.match(/输入\s*¥?\s*([\d.]+)\s*\/\s*MTok[\s\S]{0,100}?输出\s*¥?\s*([\d.]+)\s*\/\s*MTok[\s\S]{0,100}?缓存命中\s*¥?\s*([\d.]+)\s*\/\s*MTok/i)
    if (!match) throw new Error('Kimi K3 费率卡片无法按明确输入/输出/缓存顺序解析')
    return [candidate('kimi-k3', Number(match[1]), Number(match[2]), Number(match[3]), 'CNY', source.url, match[0])]
  }
  return []
}

export function validateCandidate(candidateValue, model) {
  if (!model || !model.plans?.length) return '模型目录中没有对应的已核验 API 项'
  if (!candidateValue.modelId || candidateValue.modelId !== model.apiModelId && candidateValue.modelId !== model.id) return '模型 ID 与已核验目录不一致'
  if (candidateValue.currency !== model.currency) return `币种不符：预期 ${model.currency}，来源解析为 ${candidateValue.currency}`
  if (candidateValue.unit !== 'per_1m_tokens') return '计费单位不符'
  const previousPlan = model.plans.find(item => item.id === candidateValue.planId) ?? (model.plans.length === 1 ? model.plans[0] : null)
  if (candidateValue.cachedPerMillion == null && previousPlan?.tiers[0]?.cachedPerMillion != null) return '官方来源不再明确提供缓存费率；保留旧值并等待人工确认是否移除'
  const values = [candidateValue.inputPerMillion, candidateValue.outputPerMillion, candidateValue.cachedPerMillion].filter(value => value != null)
  if (values.some(value => !Number.isFinite(value) || value < 0 || value > MAX_RATE)) return '费率数值无效或超出安全范围'
  return null
}

export function applyCandidate(feed, candidateValue, checkedAt, reviewItems = []) {
  const model = feed.models.find(item => item.apiModelId === candidateValue.modelId || item.id === candidateValue.modelId)
  const error = validateCandidate(candidateValue, model)
  if (error) {
    reviewItems.push({ type: 'unverified-price', provider: model?.provider ?? null, modelId: candidateValue.modelId, source: candidateValue.source, reason: error, evidence: candidateValue.evidence })
    return { feed, changed: false, reviewed: true }
  }
  const plan = model.plans.find(item => item.id === candidateValue.planId) ?? (model.plans.length === 1 ? model.plans[0] : null)
  if (!plan) {
    reviewItems.push({ type: 'unverified-price', provider: model.provider, modelId: candidateValue.modelId, source: candidateValue.source, reason: '无法唯一匹配官方费率对应的计费计划', evidence: candidateValue.evidence })
    return { feed, changed: false, reviewed: true }
  }
  const tier = plan.tiers[0]
  const next = {
    ...tier,
    inputPerMillion: candidateValue.inputPerMillion,
    outputPerMillion: candidateValue.outputPerMillion,
    ...(candidateValue.cachedPerMillion == null ? {} : { cachedPerMillion: candidateValue.cachedPerMillion }),
  }
  const deltas = ['inputPerMillion', 'outputPerMillion', ...(candidateValue.cachedPerMillion == null ? [] : ['cachedPerMillion'])]
    .map(field => Math.abs((next[field] - tier[field]) / Math.max(Math.abs(tier[field]), 0.000001)))
  if (deltas.some(delta => delta > AUTO_CHANGE_LIMIT)) {
    reviewItems.push({ type: 'large-price-change', provider: model.provider, modelId: model.apiModelId ?? model.id, source: candidateValue.source, previous: tier, candidate: next, reason: '单次价格变化超过 50%，保留旧价等待人工复核。', evidence: candidateValue.evidence })
    return { feed, changed: false, reviewed: true }
  }
  const priceChanged = ['inputPerMillion', 'outputPerMillion', 'cachedPerMillion'].some(field => next[field] !== tier[field])
  const changed = priceChanged || model.checkedAt !== checkedAt
  if (!changed) return { feed, changed: false, reviewed: false }
  const models = feed.models.map(item => item.id !== model.id ? item : ({
    ...item, checkedAt,
    plans: item.plans.map(ratePlan => ratePlan.id !== plan.id ? ratePlan : ({ ...ratePlan, tiers: ratePlan.tiers.map((rate, index) => index ? rate : next) })),
  }))
  return { feed: { ...feed, models }, changed: true, reviewed: false }
}

function scanLifecycle(text, source, feed, reviewItems) {
  for (const model of feed.models) {
    if (!model.apiModelId || !model.provider.includes(source.provider.split('·')[0])) continue
    const normalized = text.toLowerCase()
    const at = normalized.indexOf(model.apiModelId.toLowerCase())
    if (at < 0) continue
    const context = normalized.slice(Math.max(0, at - 80), at + model.apiModelId.length + 240)
    if (/deprecated|retired|discontinued|下线|停止服务|不再提供/.test(context)) {
      reviewItems.push({ type: 'possible-retirement', provider: model.provider, modelId: model.apiModelId, source: source.url, reason: '官方页面在该模型附近出现下线/弃用文字；未自动删除或停用。' })
    }
  }
}

const discoveryPatterns = {
  '阿里云·通义千问': /\bqwen-[a-z0-9.-]+\b/gi,
  DeepSeek: /\bdeepseek-[a-z0-9.-]+\b/gi,
  '火山引擎·豆包': /\bdoubao-[a-z0-9.-]+\b/gi,
  '智谱 AI · GLM': /\bglm-[a-z0-9.-]+\b/gi,
  MiniMax: /\bminimax-[a-z0-9.-]+\b/gi,
  '百度·文心': /\bernie-[a-z0-9.-]+\b/gi,
  '腾讯·混元': /\bhunyuan-[a-z0-9.-]+\b/gi,
}

function scanNewModelIds(text, source, feed, knownSourceIds, reviewItems) {
  const pattern = discoveryPatterns[source.provider]
  if (!pattern) return []
  const existing = new Set(feed.models.map(model => model.apiModelId?.toLowerCase()).filter(Boolean))
  const ids = new Set([...text.matchAll(pattern)].map(match => match[0]))
  const known = new Set((knownSourceIds ?? []).map(id => id.toLowerCase()))
  for (const modelId of ids) {
    if (!knownSourceIds || known.has(modelId.toLowerCase()) || existing.has(modelId.toLowerCase())) continue
    const at = text.toLowerCase().indexOf(modelId.toLowerCase())
    const context = text.slice(Math.max(0, at - 100), at + modelId.length + 180)
    if (/deprecated|retired|discontinued|下线|停止服务|不再提供|调整前价格/.test(context)) continue
    reviewItems.push({
    type: 'new-model-candidate', provider: source.provider, modelId, source: source.url,
    reason: '官方页面出现目录中尚未收录的型号标识；需核验 API 可用性、地区和完整费率后才能加入计算器。',
    })
  }
  return [...ids]
}

async function getBody(source, fixture) {
  if (fixture) {
    if (!(source.id in fixture)) throw new Error('fixture does not contain this source')
    return fixture[source.id]
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(source.url, { signal: controller.signal, headers: { 'user-agent': 'AI-LAB-Model-Price-Sync/1.1 (+daily public pricing verification)' } })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.text()
    if (body.length > 12_000_000) throw new Error('official response exceeds 12 MB safety limit')
    return body
  } finally {
    clearTimeout(timer)
  }
}

export async function sync({ feed, fixture = null, sourceState = {}, now = new Date() }) {
  const next = structuredClone(feed)
  const reviewItems = []
  const failures = []
  const sourceHashes = {}
  const discoveredModelIds = { ...(sourceState.discoveredModelIds ?? {}) }
  let successfulSources = 0
  let anyChange = false
  const changedModelIds = []
  const checkedAt = now.toISOString().slice(0, 10)

  for (const source of sources) {
    try {
      const body = await getBody(source, fixture)
      const text = stripHtml(body)
      sourceHashes[source.id] = createHash('sha256').update(body).digest('hex')
      const candidates = parseSource(source, body)
      scanLifecycle(text, source, next, reviewItems)
      discoveredModelIds[source.id] = scanNewModelIds(text, source, next, sourceState.discoveredModelIds?.[source.id], reviewItems)
      if (source.parser === 'watch' && candidates.length === 0) {
        if (sourceState.sourceHashes?.[source.id] !== sourceHashes[source.id]) {
          reviewItems.push({ type: 'source-changed-needs-parser', provider: source.provider, source: source.url, reason: '官方源内容发生变化；此来源暂无无歧义费率解析器，保留旧价并等待人工核验。' })
        }
        successfulSources++
        continue
      }
      for (const value of candidates) {
        const result = applyCandidate(next, value, checkedAt, reviewItems)
        anyChange ||= result.changed
        if (result.changed) changedModelIds.push(value.modelId)
      }
      successfulSources++
    } catch (error) {
      failures.push({ provider: source.provider, source: source.url, error: error instanceof Error ? error.message : String(error) })
    }
  }

  if (successfulSources > 0) {
    next.generatedAt = now.toISOString()
    next.lastSuccessfulSyncAt = now.toISOString()
    next.syncStatus = {
      successfulSources,
      totalSources: sources.length,
      failedProviders: failures.map(item => item.provider),
      pendingReviewCount: reviewItems.length,
    }
  }
  return {
    feed: next,
    review: { generatedAt: now.toISOString(), pending: reviewItems, failures },
    sourceHashes,
    discoveredModelIds,
    successfulSources,
    changedModelIds,
    anyChange: anyChange || successfulSources > 0,
  }
}

async function loadJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return fallback }
}

async function main() {
  const fixtureArg = process.argv.find(arg => arg.startsWith('--fixture='))
  const fixture = fixtureArg ? await loadJson(resolve(process.cwd(), fixtureArg.slice('--fixture='.length)), {}) : null
  const feed = await loadJson(snapshotPath, null)
  const sourceState = await loadJson(statePath, {})
  if (!feed || feed.schemaVersion !== 1 || !Array.isArray(feed.models)) throw new Error('data/latest.json is missing or invalid')
  const result = await sync({ feed, fixture, sourceState })
  await mkdir(dataDir, { recursive: true })
  await mkdir(stateDir, { recursive: true })
  await writeFile(reviewPath, `${JSON.stringify(result.review, null, 2)}\n`)
  if (result.successfulSources > 0) await writeFile(snapshotPath, `${JSON.stringify(result.feed, null, 2)}\n`)
  await writeFile(statePath, `${JSON.stringify({ lastRunAt: new Date().toISOString(), sourceHashes: result.sourceHashes, discoveredModelIds: result.discoveredModelIds, failures: result.review.failures }, null, 2)}\n`)
  const summary = {
    successfulSources: result.successfulSources,
    failedSources: result.review.failures.length,
    pendingReviewItems: result.review.pending.length,
    changedModels: result.changedModelIds,
    lastSuccessfulSyncAt: result.feed.lastSuccessfulSyncAt,
  }
  console.log(JSON.stringify(summary, null, 2))
  if (result.successfulSources === 0) process.exitCode = 2
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(`Sync failed safely: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 2
})

