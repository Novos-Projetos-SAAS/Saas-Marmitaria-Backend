import {test} from 'node:test';
import assert from 'node:assert/strict';
test('cleanup attempts every owned fixture and cluster despite an individual failure',async()=>{
    const {closePreproductionResources}=await import('../helpers/preproductionLab.js');const calls=[];
    await assert.rejects(closePreproductionResources({fixtures:[{async close(){calls.push('fixture');throw new Error('SYNTHETIC');}}],
        clusters:[{async stop(){calls.push('source');}},{async stop(){calls.push('target');}}],async removeRoot(){calls.push('remove');}}));
    assert.deepEqual(calls,['fixture','target','source','remove']);
});
test('cleanup preserves the temporary directory if any owned cluster cannot be confirmed stopped',async()=>{
    const {closePreproductionResources}=await import('../helpers/preproductionLab.js');const calls=[];
    await assert.rejects(closePreproductionResources({fixtures:[],clusters:[{async stop(){calls.push('source');}},{async stop(){calls.push('target');throw new Error('SYNTHETIC');}}],
        async removeRoot(){calls.push('remove');}}));
    assert.deepEqual(calls,['target','source']);
});
