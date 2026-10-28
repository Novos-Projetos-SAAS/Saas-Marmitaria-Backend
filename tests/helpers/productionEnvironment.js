export function syntheticProductionEnvironment(connection={host:'127.0.0.1',port:55439,database:'infinitepay_phase1_test'}) {
    return {NODE_ENV:'production',INFINITEPAY_MODE:'production',DB_HOST:connection.host,DB_PORT:String(connection.port),DB_NAME:connection.database,
        INFINITEPAY_DATABASE_NAME:connection.database,INFINITEPAY_DATABASE_ID:'f435ba5a-1794-4332-aa1e-2feb38075834',
        INFINITEPAY_PUBLIC_ORIGIN:'https://backend.invalid.test',INFINITEPAY_SUCCESS_URL:'https://shop.invalid.test/pedido/sucesso',
        INFINITEPAY_ALLOWED_PUBLIC_ORIGINS:'https://backend.invalid.test,https://shop.invalid.test',ALLOWED_ORIGINS:'https://shop.invalid.test',
        INFINITEPAY_TRUSTED_PROXY_IPS:'127.0.0.1'};
}
