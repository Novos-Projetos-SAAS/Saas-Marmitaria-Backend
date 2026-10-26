export async function closeDemo({ server, io, financial, db }) {
    const pending = financial.stop();
    const socketsClosed = new Promise(resolve => io.close(resolve));
    server.closeAllConnections();
    await socketsClosed;
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await pending;
    await db.destroy();
}
