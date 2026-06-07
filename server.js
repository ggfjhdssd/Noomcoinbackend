// ═══════════════════════════════════════
//  NoomCoin — Single Entry Point
//  Starts Express API + Telegram Bot
// ═══════════════════════════════════════
const { app, startBot } = require('./index');

const PORT = process.env.PORT || 10000;

app.listen(PORT, async () => {
    console.log(`
╔══════════════════════════════════════╗
║   🚀 NoomCoin Server is Running!     ║
╠══════════════════════════════════════╣
║ 📡 Port  : ${PORT}                       ║
║ 🌐 API   : /api/*                    ║
║ 🤖 Bot   : Telegram Polling          ║
╚══════════════════════════════════════╝
    `);
    try {
        await startBot();
    } catch (err) {
        console.error('❌ Bot failed to start:', err.message);
        // API server stays alive even if bot fails
    }
});

process.once('SIGINT',  () => { console.log('\n🛑 Shutting down...'); process.exit(0); });
process.once('SIGTERM', () => { console.log('\n🛑 Shutting down...'); process.exit(0); });
