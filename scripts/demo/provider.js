import { randomBytes, randomUUID } from 'node:crypto';

export const DEMO_KEY = 'SYNTHETIC_INFINITEPAY_DEMO_ONLY';
export const DEMO_ORIGIN = 'https://localhost:55446';
export async function prepareDemoProvider(db) {
    return db.transaction(async db => {
        await db.raw("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':demo-provider',0))");
        if (!await db.schema.hasTable('demo_provider_settings')) {
            await db.schema.createTable('demo_provider_settings', t => {
                t.integer('id').primary();t.text('creation_mode').notNullable();t.integer('dispatches').notNullable().defaultTo(0);
            });
        }
        await db('demo_provider_settings').insert({id:1,creation_mode:'PENDING'}).onConflict('id').ignore();
        if (!await db.schema.hasTable('demo_checkout_links')) await db.schema.createTable('demo_checkout_links', t => {
            t.text('token').primary();t.text('order_nsu').notNullable().unique();t.jsonb('payload').notNullable();
            t.text('transaction_nsu').notNullable().unique();t.text('invoice_slug').notNullable().unique();
            t.boolean('paid').notNullable().defaultTo(false);t.text('capture_method').nullable();
            t.integer('amount').notNullable();t.timestamp('created_at',{useTz:true}).defaultTo(db.fn.now());
        });
    });
}
export function createDemoProvider(db) {
    const json = value => ({status:200,json:async()=>value});
    async function find(token) {
        if (!/^[A-Za-z0-9_-]{43}$/.test(token || '')) throw new Error('Checkout sintético indisponível.');
        const link=await db('demo_checkout_links').where({token}).first();
        if (!link) throw new Error('Checkout sintético indisponível.');
        return link;
    }
    return {
        find,
        async setMode(mode) {
            if (!['PENDING','UNCERTAIN','ERROR'].includes(mode)) throw new Error('Cenário inválido.');
            await db('demo_provider_settings').where({id:1}).update({creation_mode:mode});
        },
        async approve(token, method) {
            if (!['pix','credit_card'].includes(method)) throw new Error('Meio sintético inválido.');
            return db.transaction(async trx => {
                const link=await find(token);
                const current=await trx('demo_checkout_links').where({token}).forUpdate().first();
                if (current.paid && current.capture_method !== method) throw new Error('Pagamento sintético já registrado por outro meio.');
                if (!current.paid && Date.parse(link.payload.options.valid_until) <= Date.now()) throw new Error('Checkout sintético expirado.');
                await trx('demo_checkout_links').where({token}).update({paid:true,capture_method:method});
            });
        },
        async event(token) {
            const link=await find(token);
            return {event_type:link.paid?'paid':'created',order_nsu:link.order_nsu,transaction_nsu:link.transaction_nsu,
                invoice_slug:link.invoice_slug,...(link.paid?{receipt_url:DEMO_ORIGIN+'/'+link.transaction_nsu}:{})};
        },
        async transport(url, request) {
            // This transport never performs network I/O, including on failures.
            if (request?.method !== 'POST' || request.headers?.['X-Api-Key'] !== DEMO_KEY ||
                !['https://api.checkout.infinitepay.io/links','https://api.checkout.infinitepay.io/payment_check'].includes(url))
                throw new Error('Transporte de demonstração recusado.');
            const body=JSON.parse(request.body);
            if (url.endsWith('/links')) {
                let mode;
                const link=await db.transaction(async trx => {
                    const settings=await trx('demo_provider_settings').where({id:1}).forUpdate().first();mode=settings.creation_mode;
                    await trx('demo_provider_settings').where({id:1}).update({creation_mode:'PENDING',dispatches:settings.dispatches+1});
                    if (mode==='ERROR') return null;
                    if (new URL(body.redirect_url).origin !== DEMO_ORIGIN || new URL(body.webhook.url).origin !== DEMO_ORIGIN)
                        throw new Error('Callbacks de demonstração recusados.');
                    const [row]=await trx('demo_checkout_links').insert({token:randomBytes(32).toString('base64url'),order_nsu:body.order_nsu,payload:body,
                        transaction_nsu:'DEMO-'+randomUUID(),invoice_slug:'DEMO-'+randomUUID(),
                        amount:body.items.reduce((total,item)=>total+item.price*item.quantity,0)}).returning('*');
                    return row;
                });
                if (mode==='UNCERTAIN' || mode==='ERROR') throw new Error('Falha de rede exclusivamente simulada.');
                return json({url:DEMO_ORIGIN+'/__demo/checkout/'+link.token});
            }
            const link=await db('demo_checkout_links').where({order_nsu:body.order_nsu,transaction_nsu:body.transaction_nsu,invoice_slug:body.slug}).first();
            if (!link || body.handle !== 'demo-sintetica') throw new Error('Identificação sintética divergente.');
            return json(link.paid ? {success:true,paid:true,amount:link.amount,paid_amount:link.amount,installments:1,capture_method:link.capture_method,
                receipt_url:DEMO_ORIGIN+'/'+link.transaction_nsu} : {success:true,paid:false});
        }
    };
}
