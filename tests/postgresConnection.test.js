import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePostgresUrl, financialPostgresConnection} from '../src/config/postgresConnection.js';

const neon = 'postgresql://operator:p%40ssword@ep-test-pooler.us-east-2.aws.neon.tech/marmitaria?sslmode=require&channel_binding=require';

test('Neon TLS options are accepted without weakening verification', () => {
    const parsed = parsePostgresUrl(neon, {financialProduction:true});
    assert.equal(parsed.database, 'marmitaria');
    assert.equal(parsed.password, 'p@ssword');
    assert.equal(parsed.channelBindingRequired, true);
    const connection = financialPostgresConnection(neon);
    assert.equal(connection.ssl.rejectUnauthorized, true);
    assert.equal(connection.host, parsed.host);
    assert.equal(connection.enableChannelBinding, true);
    assert.equal(connection.connectionString, undefined);
});

test('financial mode rejects disabled TLS and unexpected URL options', () => {
    for (const url of [
        'postgresql://user:pw@db.example.com/main?sslmode=disable',
        'postgresql://user:pw@db.example.com/main?sslmode=no-verify',
        'postgresql://user:pw@db.example.com/main?sslmode=require&sslmode=require',
        'postgresql://user:pw@db.example.com/main?options=-c%20search_path%3Devil',
        'postgresql://user:pw@db.example.com/main#fragment'
    ]) {
        assert.throws(() => financialPostgresConnection(url));
    }
});

test('rejects missing host, username and invalid protocols', () => {
    for (const url of [
        'http://user:pw@db.example.com/main',
        'postgresql:///main',
        'postgresql://db.example.com/main',
        'not-a-url'
    ]) assert.throws(() => financialPostgresConnection(url));
});

test('a custom CA can be supplied without accepting untrusted certificates', () => {
    const connection = financialPostgresConnection(neon, {ca:'private CA'});
    assert.deepEqual(connection.ssl, {rejectUnauthorized:true, ca:'private CA'});
});
