import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolatedTestConnection } from '../../src/config/isolatedTestDatabase.js';
test('test environment refuses production-like connections instead of falling back to DATABASE_URL', () => {
    for (const value of [undefined, 'postgresql://u@db.example.com/infinitepay_any_test',
        'postgresql://u@127.0.0.1/production', 'postgresql://u@127.0.0.1/infinitepay_any_test?host=remote']) {
        assert.throws(() => isolatedTestConnection(value === undefined ? '' : value));
    }
    assert.equal(isolatedTestConnection('postgresql://u@127.0.0.1:55439/infinitepay_any_test').ssl, false);
});
