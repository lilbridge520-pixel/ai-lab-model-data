import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyCandidate, parseSource, sources, sync } from '../sync.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const feed = JSON.parse(await readFile(resolve(here, '../data/latest.json'), 'utf8'))
const fixture = JSON.parse(await readFile(resolve(here, 'fixtures/official-pricing-snippets.json'), 'utf8'))
const fixedDate = new Date('2026-10-14T02:00:00.000Z')

test('official source parsers normalize per-thousand and per-million prices', () => {
  const qwen = parseSource(sources.find(source => source.id === 'qwen-pricing'), fixture['qwen-pricing'])[0]
  assert.deepEqual([qwen.modelId, qwen.inputPerMillion, qwen.outputPerMillion, qwen.currency], ['qwen-max', 2.4, 9.6, 'CNY'])

  const deepseek = parseSource(sources.find(source => source.id === 'deepseek-pricing'), fixture['deepseek-pricing'])
  assert.deepEqual(deepseek.map(rate => [rate.modelId, rate.planId, rate.inputPerMillion, rate.cachedPerMillion, rate.outputPerMillion]), [
    ['deepseek-flash', 'off-peak', 1, 0.02, 4], ['deepseek-flash', 'peak', 2, 0.04, 8],
    ['deepseek-v4-pro', 'off-peak', 4.5, 0.15, 13.5], ['deepseek-v4-pro', 'peak', 9, 0.3, 27],
  ])

  const baidu = parseSource(sources.find(source => source.id === 'baidu-qianfan-pricing'), fixture['baidu-qianfan-pricing'])[0]
  assert.equal(baidu.inputPerMillion, 0.8)
  assert.equal(baidu.outputPerMillion, 3.2)
  assert.equal(baidu.currency, 'CNY')

  const kimi = parseSource(sources.find(source => source.id === 'kimi-models-pricing'), fixture['kimi-models-pricing'])[0]
  assert.equal(kimi.inputPerMillion, 20)
  assert.equal(kimi.cachedPerMillion, 2)
  assert.equal(kimi.outputPerMillion, 100)
})

test('DeepSeek source update maps independently to peak and off-peak plans', () => {
  const result = sync({ feed, fixture: { 'deepseek-pricing': fixture['deepseek-pricing'] }, now: fixedDate })
  return result.then(({ feed: next }) => {
    const plans = next.models.find(item => item.id === 'deepseek-v4-pro').plans
    assert.deepEqual(plans.map(plan => [plan.tiers[0].inputPerMillion, plan.tiers[0].cachedPerMillion, plan.tiers[0].outputPerMillion]), [
      [4.5, 0.15, 13.5], [9, 0.3, 27],
    ])
  })
})

test('a modest official price change updates the data feed', () => {
  const model = feed.models.find(item => item.id === 'kimi-k3')
  const plan = model.plans[0]
  const changed = applyCandidate(feed, {
    modelId: 'kimi-k3', inputPerMillion: 22, cachedPerMillion: 2, outputPerMillion: 100,
    currency: 'CNY', unit: 'per_1m_tokens', source: model.source, evidence: 'test fixture',
  }, '2026-10-14')
  assert.equal(changed.changed, true)
  assert.equal(changed.feed.models.find(item => item.id === model.id).plans[0].tiers[0].inputPerMillion, 22)
  assert.equal(plan.tiers[0].inputPerMillion, 20)
})

test('large, invalid-currency, or unknown-ID changes remain pending and keep old data', () => {
  const model = feed.models.find(item => item.id === 'kimi-k3')
  const pending = []
  const result = applyCandidate(feed, {
    modelId: 'kimi-k3', inputPerMillion: 40, cachedPerMillion: 2, outputPerMillion: 100,
    currency: 'CNY', unit: 'per_1m_tokens', source: model.source, evidence: 'test fixture',
  }, '2026-10-14', pending)
  assert.equal(result.changed, false)
  assert.equal(pending[0].type, 'large-price-change')
  assert.equal(result.feed.models.find(item => item.id === model.id).plans[0].tiers[0].inputPerMillion, 20)

  const invalid = applyCandidate(feed, {
    modelId: 'kimi-k3', inputPerMillion: 21, cachedPerMillion: 2, outputPerMillion: 100,
    currency: 'USD', unit: 'per_1m_tokens', source: model.source, evidence: 'test fixture',
  }, '2026-10-14', pending)
  assert.equal(invalid.changed, false)
  assert.match(pending[1].reason, /币种/)

  const missingCache = applyCandidate(feed, {
    modelId: 'kimi-k3', inputPerMillion: 20, cachedPerMillion: null, outputPerMillion: 100,
    currency: 'CNY', unit: 'per_1m_tokens', source: model.source, evidence: 'cache rate missing',
  }, '2026-10-14', pending)
  assert.equal(missingCache.changed, false)
  assert.match(pending[2].reason, /缓存费率/)
})

test('new IDs from a successful official source go to review without entering the calculator', async () => {
  const deepseekFixture = `${fixture['deepseek-pricing']} deepseek-v5-pro`
  const sourceState = { discoveredModelIds: { 'deepseek-pricing': ['deepseek-flash', 'deepseek-v4-pro'] } }
  const result = await sync({ feed, fixture: { 'deepseek-pricing': deepseekFixture }, sourceState, now: fixedDate })
  assert.ok(result.review.pending.some(item => item.type === 'new-model-candidate' && item.modelId === 'deepseek-v5-pro'))
  assert.equal(result.feed.models.some(item => item.apiModelId === 'deepseek-v5-pro'), false)
})

test('the first source scan seeds discovered IDs instead of mislabeling the existing catalog as new', async () => {
  const result = await sync({ feed, fixture, now: fixedDate })
  assert.ok(result.discoveredModelIds['qwen-pricing'].includes('qwen-max'))
  assert.equal(result.review.pending.some(item => item.type === 'new-model-candidate'), false)
})

test('source failures preserve the prior snapshot while successful providers continue', async () => {
  const result = await sync({ feed, fixture, now: fixedDate })
  assert.ok(result.successfulSources >= 3)
  assert.ok(result.review.failures.length > 0)
  assert.equal(result.feed.models.find(item => item.id === 'qwen-max').plans[0].tiers[0].inputPerMillion, 2.4)
  assert.equal(result.feed.models.find(item => item.id === 'kimi-k3').plans[0].tiers[0].inputPerMillion, 20)
  assert.equal(result.feed.lastSuccessfulSyncAt, fixedDate.toISOString())
})

test('an unavailable source does not mark a model retired', async () => {
  const startingFeed = structuredClone(feed)
  startingFeed.lastSuccessfulSyncAt = null
  const result = await sync({ feed: startingFeed, fixture: {}, now: fixedDate })
  assert.equal(result.successfulSources, 0)
  assert.equal(result.feed.models.find(item => item.id === 'tencent-hunyuan-a13b').status, 'verified')
  assert.equal(result.feed.models.find(item => item.id === 'tencent-hunyuan-a13b').plans[0].tiers[0].inputPerMillion, 0.5)
  assert.equal(result.feed.lastSuccessfulSyncAt, null)
})

