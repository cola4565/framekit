import assert from 'node:assert/strict'
import {
  compareVersions,
  isNewerVersion,
  normalizeVersion
} from '../src/shared/version'

assert.equal(normalizeVersion('v1.0.0'), '1.0.0')
assert.equal(normalizeVersion('  v2.3.4  '), '2.3.4')

assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
assert.equal(compareVersions('1.0.1', '1.0.0'), 1)
assert.equal(compareVersions('0.9.9', '1.0.0'), -1)
assert.equal(compareVersions('1.10.0', '1.9.9'), 1)
assert.equal(compareVersions('2.0.0', '2.0.0-beta.2'), 1)
assert.equal(compareVersions('2.0.0-beta.2', '2.0.0-beta.11'), -1)
assert.equal(compareVersions('2.0.0-rc.1', '2.0.0-beta.9'), 1)

assert.equal(isNewerVersion('v1.0.1', '1.0.0'), true)
assert.equal(isNewerVersion('1.0.0', '1.0.0'), false)
assert.equal(isNewerVersion('0.9.9', '1.0.0'), false)

assert.throws(() => compareVersions('latest', '1.0.0'), /无法识别的版本号/)

console.log('PASS update smoke: semver normalization, comparison and prerelease ordering')
