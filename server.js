// ══════════════════════════════════════════════════════
//  NoomCoin — server.js
//  Single entry point: starts Express API + Telegram Bot
//  Deploy on Render: startCommand = node server.js
// ══════════════════════════════════════════════════════
const { app, startBot } = require('./index');

const PORT = process.env.PORT || 10000;

app.listen(PORT, async () => {
    console.log(`
╔══════════════════════════════════════╗
║   🚀 NoomCoin Server Ready!          ║
╠══════════════════════════════════════╣
║ 📡 Port  : ${String(PORT).padEnd(28)}║
║ 🌐 API   : https://noomcoinbackend.onrender.com ║
║ 🤖 Bot   : @NoomCoinads_bot          ║
╚══════════════════════════════════════╝
    `);
    // Start Telegram bot alongside the API
    try {
        await startBot();
    } catch (err) {
        console.error('❌ Bot failed to start:', err.message);
        // API server stays alive even if bot token is wrong
    }
});

process.once('SIGINT',  () => { console.log('\n🛑 Graceful shutdown...'); process.exit(0); });
process.once('SIGTERM', () => { console.log('\n🛑 Graceful shutdown...'); process.exit(0); });
