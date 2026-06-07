const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');

const app = express();

// ==================== Trust Proxy ====================
app.set('trust proxy', 1);

// ==================== Security & Middlewares ====================
app.use(helmet());
// CORS — allow Vercel frontend + open for Telegram WebApp
app.use(cors({
    origin: (origin, callback) => callback(null, true), // Allow all origins (Telegram WebApp)
    /*
    origin: [
        'https://noomcoin.vercel.app',
        'http://localhost:3000'
    ],
    */
    methods: ['GET','POST','PUT','DELETE','OPTIONS','PATCH'],
    allowedHeaders: ['Content-Type','X-Telegram-Init-Data','Authorization'],
    credentials: true
}));
app.options('*', cors());
app.use(express.json({ limit: '15mb' })); // Allow large base64 screenshots for VIP purchase

// ==================== HTML Escape Function ====================
function escapeHTML(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
        .replace(/\*/g, '&#42;')
        .replace(/_/g, '&#95;')
        .replace(/\[/g, '&#91;')
        .replace(/\]/g, '&#93;')
        .replace(/\(/g, '&#40;')
        .replace(/\)/g, '&#41;');
}

// ==================== Profile Images Array ====================
const DEFAULT_PHOTO = 'https://raw.githubusercontent.com/ggfjhdssd/noomcoin-telegram-app/main/public/images/fa6a539141b9eeae723f551b9d67b875.jpg';
const PROFILE_IMAGES = [
    'https://raw.githubusercontent.com/ggfjhdssd/noomcoin-telegram-app/main/public/images/fa6a539141b9eeae723f551b9d67b875.jpg',
    'https://raw.githubusercontent.com/ggfjhdssd/noomcoin-telegram-app/main/public/images/df0dc02ae9f245b580f060ddf3abdc85.jpg',
    'https://raw.githubusercontent.com/ggfjhdssd/noomcoin-telegram-app/main/public/images/bea9c880a09e1900ee04041881465993.jpg',
    'https://raw.githubusercontent.com/ggfjhdssd/noomcoin-telegram-app/main/public/images/a06d1ec553144a0a6056926cacc222b9.jpg',
];

// ==================== Valid Task IDs ====================
const VALID_TASK_IDS = ['task1', 'task2', 'task3', 'task4', 'task5', 'task6', 'task7'];

// ==================== Rate Limiting ====================
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 150,
    message: { error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.headers['x-forwarded-for']?.split(',')[0] || req.ip || req.connection.remoteAddress
});
app.use('/api/', apiLimiter);

const claimLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    message: { error: 'Too many clicks. Please slow down.' },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.tgUser?.id?.toString() || req.headers['x-forwarded-for']?.split(',')[0] || req.ip
});

// ==================== MongoDB Connection (Optimized) ====================
let cachedDb = null;
let connectionPromise = null;

async function connectToDatabase() {
    if (cachedDb && mongoose.connection.readyState === 1) {
        console.log('✅ Using cached database connection');
        return cachedDb;
    }

    if (connectionPromise) {
        console.log('⏳ Waiting for existing connection attempt...');
        return connectionPromise;
    }

    console.log('🔄 Connecting to MongoDB...');
    console.log('MongoDB URI exists:', !!process.env.MONGODB_URI);
    
    if (!process.env.MONGODB_URI) {
        throw new Error('MONGODB_URI is not defined in environment variables');
    }
    
    connectionPromise = mongoose.connect(process.env.MONGODB_URI, {
        serverSelectionTimeoutMS: 30000,
        socketTimeoutMS: 60000,
        connectTimeoutMS: 30000,
        maxPoolSize: 5,
        minPoolSize: 1,
    }).then((connection) => {
        cachedDb = connection;
        connectionPromise = null;
        console.log('✅ MongoDB connected successfully');
        return connection;
    }).catch((err) => {
        connectionPromise = null;
        console.error('❌ MongoDB connection error:', err.message);
        console.error('Full error details:', err);
        throw err;
    });

    return connectionPromise;
}

// ==================== Health Check Endpoint ====================
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        time: new Date().toISOString(),
        env: {
            mongoUri: process.env.MONGODB_URI ? 'exists' : 'missing',
            botToken: process.env.BOT_TOKEN ? 'exists' : 'missing',
            adminId: process.env.ADMIN_ID ? 'exists' : 'missing',
            renderBotUrl: process.env.RENDER_BOT_URL ? 'exists' : 'missing'
        }
    });
});

// ==================== MongoDB Models ====================
const configSchema = new mongoose.Schema({
    key: { type: String, unique: true },
    value: mongoose.Schema.Types.Mixed
});
const Config = mongoose.model('Config', configSchema);

// ==================== User Schema with isBypassed field ====================
const userSchema = new mongoose.Schema({
    userId: { type: Number, required: true, unique: true },
    username: String,
    firstName: String,
    lastName: String,
    photoUrl: { type: String, default: DEFAULT_PHOTO },
    coins: { type: Number, default: 0 },
    dailyLastClaim: { type: Number, default: 0 },
    tasks: { type: Map, of: Number, default: {} },
    videoTasks: { type: Map, of: {
        count: Number,
        lastClaim: Number,
        date: Number
    }, default: {} },
    dailyVideoCount: { type: Number, default: 0 },
    lastVideoDate: { type: Date, default: null },
    referredBy: { type: Number, default: null },
    referralCount: { type: Number, default: 0 },
    unclaimedReferrals: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
    banned: { type: Boolean, default: false },
    isBypassed: { type: Boolean, default: false }, // NEW: VIP Bypass
    spinTickets: { type: Number, default: 0 },
    hasReceivedFreeTicket: { type: Boolean, default: false },
    adWatchCount: { type: Number, default: 0 },
    lastAdWatch: { type: Number, default: 0 },
    adCooldownEndTime: { type: Number, default: 0 },
    vipMode: { type: Boolean, default: false },
    vipExpiry: { type: Date, default: null },
    lastTaskReset: { type: Number, default: 0 }, // timestamp of last global task reset
    gameSession: {
        active: { type: Boolean, default: false },
        startTime: { type: Number, default: 0 },
        tempScore: { type: Number, default: 0 }
    }
});
const User = mongoose.model('User', userSchema);

const withdrawalSchema = new mongoose.Schema({
    userId: { type: Number, required: true },
    amount: { type: Number, required: true },
    method: { type: String, enum: ['kpay', 'wavepay', 'binance'], required: true },
    accountDetails: { type: String, required: true },
    status: { type: String, enum: ['pending', 'completed', 'rejected'], default: 'pending' },
    rejectReason: { type: String, default: null },
    createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 30 }
});
const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);

// ==================== VIP Purchase Schema ====================
const vipPurchaseSchema = new mongoose.Schema({
    userId: { type: Number, required: true },
    username: String,
    firstName: String,
    amount: { type: Number, default: 5000 },
    paymentMethod: { type: String, enum: ['kpay', 'wave'] },
    screenshotData: { type: String }, // base64 screenshot
    status: { type: String, enum: ['pending', 'confirmed', 'rejected'], default: 'pending' },
    createdAt: { type: Date, default: Date.now }
});
// 7-day TTL for pending records (confirmed ones kept 30 days)
vipPurchaseSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });
const VipPurchase = mongoose.model('VipPurchase', vipPurchaseSchema);

// ==================== Default Configuration ====================
const DEFAULT_CONFIG = {
    REFERRAL_REWARD: 50,
    DAILY_REWARD: 24,
    TASK_REWARD: 40,
    HOME_TASK_REWARD: 45,
    MIN_WITHDRAWAL: parseInt(process.env.MIN_WITHDRAWAL) || 100000,
    TASK_COOLDOWN: 15 * 60 * 1000, // 15 minutes
    DAILY_COOLDOWN: 24 * 60 * 60 * 1000,
    CHANNEL_URL: 'https://t.me/NoomCoinads_bot',
    CHANNEL_JOIN_REQUIRED: true,
    VPN_MODE: true, // true = VPN gate on, false = bypass VPN check
    MAINTENANCE_MODE: false,
    MAINTENANCE_MESSAGE: 'Site is under maintenance. Please check back later.',
    // VIP Card visibility (admin can hide/show)
    VIP_CARD_VISIBLE: true,
    // Currency mode: 'coin' = 🪙, 'mmk' = ကျပ်
    CURRENCY_MODE: 'coin',
    // Home tab task labels (customizable)
    DAILY_CHECKIN_LABEL: 'Daily Check-in',
    DAILY_CHECKIN_REWARD_LABEL: '+24 coins (Watch Ad)',
    TASK1_LABEL: 'Task 1',
    TASK1_REWARD_LABEL: '+45 coins (Watch Ad)',
    TASK1_BTN_LABEL: 'Get +45',
    TASK2_LABEL: 'Task 2',
    TASK2_REWARD_LABEL: '+45 coins (Watch Ad)',
    TASK2_BTN_LABEL: 'Get +45',
    TASK3_LABEL: 'Task 3',
    TASK3_REWARD_LABEL: '+45 coins (Watch Ad)',
    TASK3_BTN_LABEL: 'Get +45',
    TASK4_LABEL: 'Task 4',
    TASK4_REWARD_LABEL: '+45 coins (Watch Ad)',
    TASK4_BTN_LABEL: 'Get +45',
    // Earn tab labels
    EARN_REWARD_LABEL: '+45🪙',
    EARN_WATCH_LABEL: 'ကြည့်ရန် အသင့်',
};

async function getConfig(key) {
    let cfg = await Config.findOne({ key });
    if (!cfg) {
        cfg = new Config({ key, value: DEFAULT_CONFIG[key] });
        await cfg.save();
    }
    return cfg.value;
}

async function setConfig(key, value) {
    await Config.updateOne({ key }, { value }, { upsert: true });
}

async function initConfigFromEnv() {
    try {
        const envOverrides = { MIN_WITHDRAWAL: process.env.MIN_WITHDRAWAL };
        for (const [key, envValue] of Object.entries(envOverrides)) {
            if (envValue !== undefined && DEFAULT_CONFIG.hasOwnProperty(key)) {
                const existing = await Config.findOne({ key });
                if (!existing) {
                    const numValue = isNaN(envValue) ? envValue : parseInt(envValue);
                    await setConfig(key, numValue);
                    console.log(`✅ Initialized ${key} = ${numValue} from environment`);
                }
            }
        }
    } catch (err) {
        console.error('❌ Config initialization error:', err);
    }
}

// ==================== Helper Functions ====================
function validateTelegramData(initData) {
    const BOT_TOKEN = process.env.BOT_TOKEN;
    if (!initData || !BOT_TOKEN) return null;
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        params.delete('hash');
        const dataCheckString = Array.from(params.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => `${key}=${value}`)
            .join('\n');
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
        return calculatedHash === hash ? Object.fromEntries(params) : null;
    } catch (err) {
        console.error('Validation error:', err);
        return null;
    }
}

async function authMiddleware(req, res, next) {
    // Bot internal requests bypass auth
    if (req.headers['x-telegram-init-data'] === 'bot') {
        req.isBot = true;
        req.tgUser = { id: parseInt(process.env.ADMIN_ID) || 0 };
        return next();
    }

    const initData = req.headers['x-telegram-init-data'];
    if (!initData) {
        return res.status(401).json({ error: 'Missing Telegram init data' });
    }

    const userData = validateTelegramData(initData);
    if (!userData || !userData.user) {
        return res.status(403).json({ error: 'Invalid Telegram init data' });
    }

    try {
        req.tgUser = JSON.parse(userData.user);
        if (!req.tgUser || !req.tgUser.id) {
            return res.status(403).json({ error: 'Invalid user data structure' });
        }
        next();
    } catch (err) {
        console.error('authMiddleware parse error:', err);
        return res.status(403).json({ error: 'Failed to parse user data' });
    }
}

async function adminMiddleware(req, res, next) {
    // Bot internal requests are admin
    if (req.isBot) return next();

    const initData = req.headers['x-telegram-init-data'];
    if (!initData) {
        return res.status(401).json({ error: 'Missing Telegram init data' });
    }

    const userData = validateTelegramData(initData);
    if (!userData || !userData.user) {
        return res.status(403).json({ error: 'Invalid Telegram init data' });
    }

    try {
        req.tgUser = JSON.parse(userData.user);
        if (!req.tgUser || !req.tgUser.id) {
            return res.status(403).json({ error: 'Invalid user data structure' });
        }
        if (!isAdmin(req.tgUser.id)) {
            return res.status(403).json({ error: 'Admin access required' });
        }
        next();
    } catch (err) {
        console.error('adminMiddleware error:', err);
        return res.status(500).json({ error: 'Auth error: ' + err.message });
    }
}

// ==================== UPDATED: maintenanceCheck with Bypass ====================
async function maintenanceCheck(req, res, next) {
    const maintenance = await getConfig('MAINTENANCE_MODE');
    const isOn = maintenance === true || maintenance === 'true';
    
    // If maintenance mode is off, proceed
    if (!isOn) {
        return next();
    }
    
    // Check if user is admin
    if (req.tgUser && isAdmin(req.tgUser.id)) {
        return next();
    }
    
    // Check if user has bypass permission
    try {
        const user = await User.findOne({ userId: req.tgUser.id });
        if (user && user.isBypassed) {
            console.log(`🚀 User ${req.tgUser.id} bypassed maintenance mode`);
            return next();
        }
    } catch (err) {
        console.error('Error checking bypass status:', err);
    }
    
    // Otherwise, show maintenance message
    const message = await getConfig('MAINTENANCE_MESSAGE');
    return res.status(503).json({ error: message || 'Maintenance mode' });
}

function isAdmin(userId) {
    const ADMIN_ID = parseInt(process.env.ADMIN_ID);
    return Number(userId) === Number(ADMIN_ID);
}

async function getOrCreateUser(tgUser, referrerId = null) {
    let user = await User.findOne({ userId: tgUser.id });
    
    if (!user) {
        // Create new user
        user = new User({
            userId: tgUser.id,
            username: tgUser.username || '',
            firstName: tgUser.first_name || '',
            lastName: tgUser.last_name || '',
            photoUrl: DEFAULT_PHOTO,
            coins: 0,
            dailyLastClaim: 0,
            tasks: new Map(),
            videoTasks: new Map(),
            dailyVideoCount: 0,
            lastVideoDate: null,
            referredBy: referrerId ? parseInt(referrerId) : null,
            referralCount: 0,
            unclaimedReferrals: 0,
            createdAt: Date.now(),
            banned: false,
            isBypassed: false, // NEW: default false
            spinTickets: 1,
            hasReceivedFreeTicket: true,
            adWatchCount: 0,
            lastAdWatch: 0,
            adCooldownEndTime: 0,
            vipMode: false,
            vipExpiry: null,
            lastTaskReset: 0,
            gameSession: { active: false, startTime: 0, tempScore: 0 }
        });
        await user.save();
        console.log(`✅ New user created: ${tgUser.id}`);

        if (referrerId && parseInt(referrerId) !== tgUser.id) {
            const referrer = await User.findOne({ userId: parseInt(referrerId) });
            if (referrer) {
                const refReward = await getConfig('REFERRAL_REWARD');
                referrer.coins += Number(refReward) || 50;
                referrer.referralCount += 1;
                referrer.unclaimedReferrals += 1;
                await referrer.save();
                console.log(`✅ Referrer ${referrer.userId} got +${refReward} coins, referral count: ${referrer.referralCount}`);

                if (process.env.RENDER_BOT_URL) {
                    axios.post(`${process.env.RENDER_BOT_URL}/referral-notify`, {
                        referrerId: referrer.userId,
                        newUserId: tgUser.id
                    }, { timeout: 5000 }).catch(err => {
                        console.error('Failed to send referral notification:', err.message);
                    });
                }
            }
        }

        if (process.env.RENDER_BOT_URL) {
            axios.post(`${process.env.RENDER_BOT_URL}/fetch-photo`, {
                userId: tgUser.id
            }, {
                headers: { 'X-Telegram-Init-Data': 'bot' },
                timeout: 5000
            }).catch(err => console.error('Failed to trigger photo fetch:', err.message));
        }
    } else {
        // Update existing user info
        let updated = false;
        if (tgUser.username && user.username !== tgUser.username) {
            user.username = tgUser.username;
            updated = true;
        }
        if (tgUser.first_name && user.firstName !== tgUser.first_name) {
            user.firstName = tgUser.first_name;
            updated = true;
        }
        if (tgUser.last_name && user.lastName !== tgUser.last_name) {
            user.lastName = tgUser.last_name;
            updated = true;
        }
        if (updated) {
            await user.save();
            console.log(`🔄 Updated user ${tgUser.id}`);
        }
    }
    return user;
}

async function notifyBot(endpoint, data) {
    const RENDER_BOT_URL = process.env.RENDER_BOT_URL;
    if (!RENDER_BOT_URL) {
        console.warn('⚠️ RENDER_BOT_URL not set, skipping bot notification');
        return;
    }
    try {
        await axios.post(`${RENDER_BOT_URL}${endpoint}`, {
            ...data,
            adminId: parseInt(process.env.ADMIN_ID)
        }, {
            timeout: 5000,
            headers: { 'Content-Type': 'application/json' }
        });
        console.log(`✅ Bot notified: ${endpoint}`);
    } catch (err) {
        console.error(`❌ Failed to notify bot (${endpoint}):`, err.message);
    }
}

// ==================== UPDATED: VPN CHECK API with Bypass ====================
app.get('/api/check-vpn', async (req, res) => {
    try {
        await connectToDatabase();
        // Check VPN_MODE setting from DB
        const vpnSetting = await Config.findOne({ key: "VPN_MODE" });
        const vpnMode = vpnSetting ? vpnSetting.value : true;
        if (vpnMode === false || vpnMode === "false") {
            return res.json({ allowed: true, country: "Bypassed", isAdmin: false, isBypassed: false, message: "VPN mode off" });
        }

        // Get client IP
        const clientIp = req.headers['x-forwarded-for']?.split(',')[0] || 
                         req.socket.remoteAddress || 
                         req.connection.remoteAddress;
        
        // Get user ID from headers if available
        const initData = req.headers['x-telegram-init-data'];
        let userId = null;
        let isAdminUser = false;
        let isBypassedUser = false;
        
        if (initData && initData !== 'bot') {
            try {
                const userData = validateTelegramData(initData);
                if (userData && userData.user) {
                    const tgUser = JSON.parse(userData.user);
                    userId = tgUser.id;
                    isAdminUser = isAdmin(userId);
                    
                    // Check if user has bypass permission
                    if (!isAdminUser) {
                        const user = await User.findOne({ userId: userId });
                        isBypassedUser = user && user.isBypassed;
                    }
                }
            } catch (e) {
                console.error('Error parsing user data in VPN check:', e);
            }
        }

        // Admin bypass
        if (isAdminUser) {
            return res.json({
                allowed: true,
                country: 'Admin',
                isAdmin: true,
                isBypassed: false,
                message: 'Admin access granted'
            });
        }
        
        // VIP Bypass
        if (isBypassedUser) {
            console.log(`🚀 User ${userId} bypassed VPN check`);
            return res.json({
                allowed: true,
                country: 'Bypassed',
                isAdmin: false,
                isBypassed: true,
                message: 'VIP Bypass active'
            });
        }

        // Query IP-API.com
        const response = await axios.get(`http://ip-api.com/json/${clientIp}`, {
            timeout: 5000
        });

        const data = response.data;
        
        if (data.status === 'success') {
            const allowed = data.countryCode === 'SG' || data.countryCode === 'US';
            return res.json({
                allowed: allowed,
                country: data.country,
                countryCode: data.countryCode,
                isAdmin: false,
                isBypassed: false,
                message: allowed ? 'Access granted' : 'Only Singapore or United States VPN allowed'
            });
        } else {
            // Fallback - allow if we can't determine
            return res.json({
                allowed: true,
                country: 'Unknown',
                isAdmin: false,
                isBypassed: false,
                message: 'Could not verify location - access granted'
            });
        }
    } catch (error) {
        console.error('VPN check error:', error);
        // Fallback - allow on error
        res.json({
            allowed: true,
            country: 'Error',
            isAdmin: false,
            isBypassed: false,
            message: 'Error checking location - access granted'
        });
    }
});

// ==================== NEW: Toggle Bypass Status ====================
app.post('/api/admin/users/:userId/toggle-bypass', adminMiddleware, async (req, res) => {
    try {
        await connectToDatabase();
        const targetId = parseInt(req.params.userId);
        
        const user = await User.findOne({ userId: targetId });
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Toggle the bypass status
        user.isBypassed = !user.isBypassed;
        await user.save();
        
        console.log(`🚀 User ${targetId} bypass toggled to ${user.isBypassed}`);
        
        res.json({ 
            success: true, 
            isBypassed: user.isBypassed,
            message: user.isBypassed ? 'Bypass enabled' : 'Bypass disabled'
        });
    } catch (err) {
        console.error('❌ Error toggling bypass:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// ==================== User Info ====================
app.get('/api/user', authMiddleware, maintenanceCheck, async (req, res) => {
    try {
        await connectToDatabase();
        
        // Extract start_param from initData
        const initData = req.headers['x-telegram-init-data'];
        let referrerId = null;
        
        if (initData && initData !== 'bot') {
            const params = new URLSearchParams(initData);
            const startParam = params.get('start_param');
            if (startParam) {
                const match = startParam.match(/\d+/);
                if (match) {
                    referrerId = parseInt(match[0]);
                    console.log(`📎 Found referrer ID from start_param: ${referrerId}`);
                }
            }
        }
        
        const user = await getOrCreateUser(req.tgUser, referrerId);
        if (user.banned) return res.status(403).json({ error: 'Your account is banned' });

        const displayName = user.username || user.firstName || `User${user.userId}`;

        res.json({
            userId: user.userId,
            username: displayName,
            firstName: user.firstName,
            lastName: user.lastName,
            photoUrl: user.photoUrl,
            coins: user.coins,
            dailyLastClaim: user.dailyLastClaim,
            tasks: Object.fromEntries(user.tasks),
            dailyVideoCount: user.dailyVideoCount,
            lastVideoDate: user.lastVideoDate,
            referralCount: user.referralCount,
            unclaimedReferrals: user.unclaimedReferrals,
            createdAt: user.createdAt,
            banned: user.banned,
            isBypassed: user.isBypassed, // NEW: send to frontend
            spinTickets: user.spinTickets,
            adWatchCount: user.adWatchCount,
            lastAdWatch: user.lastAdWatch,
            adCooldownEndTime: user.adCooldownEndTime,
            vipMode: user.vipMode || false,
            vipExpiry: user.vipExpiry || null,
            lastTaskReset: user.lastTaskReset || 0
        });
    } catch (err) {
        console.error('❌ Error in /api/user:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// ==================== Daily Claim ====================
app.post('/api/claim/daily', authMiddleware, maintenanceCheck, claimLimiter, async (req, res) => {
    try {
        await connectToDatabase();
        const user = await getOrCreateUser(req.tgUser);
        if (user.banned) return res.status(403).json({ error: 'Banned' });

        const now = Date.now();
        const cooldown = await getConfig('DAILY_COOLDOWN');
        if (now - user.dailyLastClaim < cooldown) {
            return res.status(400).json({ error: 'Not ready', remaining: cooldown - (now - user.dailyLastClaim) });
        }

        const reward = await getConfig('DAILY_REWARD');
        user.coins += reward;
        user.dailyLastClaim = now;
        await user.save();

        res.json({ coins: user.coins, dailyLastClaim: user.dailyLastClaim });
    } catch (err) {
        console.error('❌ Error in /api/claim/daily:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// ==================== Task Claim ====================
app.post('/api/claim/task/:taskId', authMiddleware, maintenanceCheck, claimLimiter, async (req, res) => {
    try {
        await connectToDatabase();
        const { taskId } = req.params;
        if (!VALID_TASK_IDS.includes(taskId)) return res.status(400).json({ error: 'Invalid task ID' });

        const user = await getOrCreateUser(req.tgUser);
        if (user.banned) return res.status(403).json({ error: 'Banned' });

        const now = Date.now();
        const cooldown = await getConfig('TASK_COOLDOWN');
        const lastClaim = user.tasks.get(taskId) || 0;
        // Grace buffer of 5 seconds to account for frontend/backend clock drift
        const GRACE_MS = 5000;
        if (now - lastClaim < cooldown - GRACE_MS) {
            return res.status(400).json({ error: 'Not ready', remaining: cooldown - (now - lastClaim) });
        }

        const reward = await getConfig('TASK_REWARD');
        user.coins += reward;
        user.tasks.set(taskId, now);
        await user.save();

        res.json({ coins: user.coins, tasks: Object.fromEntries(user.tasks) });
    } catch (err) {
        console.error('❌ Error in /api/claim/task:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// ==================== Adsgram Reward Endpoint ====================
app.get('/api/adsgram-reward', async (req, res) => {
    try {
        await connectToDatabase();
        const { userId, type, taskId } = req.query;

        if (!userId || !type) {
            return res.status(400).send('Missing userId or type parameter');
        }

        const userIdNum = parseInt(userId);
        if (isNaN(userIdNum)) {
            return res.status(400).send('Invalid userId');
        }

        const user = await User.findOne({ userId: userIdNum });
        if (!user) {
            console.warn(`⚠️ User not found for userId: ${userIdNum}`);
            return res.status(404).send('User not found');
        }

        const now = Date.now();
        let reward = 0;
        let cooldownTime = 0;

        if (type === 'daily') {
            cooldownTime = await getConfig('DAILY_COOLDOWN');
            if (now - (user.dailyLastClaim || 0) < cooldownTime) {
                return res.status(400).send('Daily check-in is on cooldown');
            }
            reward = await getConfig('DAILY_REWARD');
            user.dailyLastClaim = now;
        } else if (type === 'task') {
            if (!taskId || !VALID_TASK_IDS.includes(taskId)) {
                return res.status(400).send('Invalid task ID');
            }
            cooldownTime = await getConfig('TASK_COOLDOWN');
            const lastClaim = user.tasks.get(taskId) || 0;
            // Grace buffer of 5 seconds to account for frontend/backend clock drift
            // and the time the user spends watching the ad after the pre-check passes.
            const GRACE_MS = 5000;
            if (now - lastClaim < cooldownTime - GRACE_MS) {
                return res.status(400).send('Task is on cooldown');
            }
            // Use HOME_TASK_REWARD if request comes from home tab
            const source = req.query.source || '';
            if (source === 'home') {
                reward = await getConfig('HOME_TASK_REWARD');
            } else {
                reward = await getConfig('TASK_REWARD');
            }
            user.tasks.set(taskId, now);
        } else {
            return res.status(400).send('Invalid reward type');
        }

        user.coins += reward;
        await user.save();

        console.log(`✅ User ${userIdNum} rewarded with ${reward} coins for ${type} ${taskId || ''}. New balance: ${user.coins}`);
        res.status(200).send('OK');
    } catch (error) {
        console.error('❌ Error in /api/adsgram-reward:', error);
        res.status(500).send('Internal Server Error');
    }
});

// ==================== POST Adsgram Reward (used by frontend JS) ====================
app.post('/api/adsgram-reward', authMiddleware, maintenanceCheck, async (req, res) => {
    try {
        await connectToDatabase();
        const { type, taskId } = req.body;
        const user = await getOrCreateUser(req.tgUser);
        if (user.banned) return res.status(403).json({ error: 'Banned' });

        const now = Date.now();
        let reward = 0;

        if (type === 'daily') {
            const cooldown = await getConfig('DAILY_COOLDOWN');
            if (now - (user.dailyLastClaim || 0) < cooldown) {
                const remaining = cooldown - (now - (user.dailyLastClaim || 0));
                return res.status(400).json({ error: 'Cooldown active', remaining });
            }
            reward = Number(await getConfig('DAILY_REWARD')) || 24;
            user.dailyLastClaim = now;
        } else if (type === 'home_task') {
            if (!taskId || !['task1','task2','task3','task4'].includes(taskId)) {
                return res.status(400).json({ error: 'Invalid taskId' });
            }
            const cooldown = await getConfig('TASK_COOLDOWN');
            const lastClaim = user.tasks.get(taskId) || 0;
            if (now - lastClaim < cooldown - 5000) {
                const remaining = cooldown - (now - lastClaim);
                return res.status(400).json({ error: 'Cooldown active', remaining });
            }
            reward = Number(await getConfig('HOME_TASK_REWARD')) || 45;
            user.tasks.set(taskId, now);
        } else {
            return res.status(400).json({ error: 'Invalid type' });
        }

        user.coins += reward;
        await user.save();
        console.log(`✅ POST adsgram-reward: User ${user.userId} +${reward} coins (${type})`);
        res.json({ success: true, reward, newCoins: user.coins });
    } catch (err) {
        console.error('❌ POST adsgram-reward error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== Withdrawal ====================
app.post('/api/withdraw', authMiddleware, maintenanceCheck, claimLimiter, async (req, res) => {
    try {
        await connectToDatabase();
        const { method, accountDetails, accountName, amount } = req.body;
        if (!method || !accountDetails || !amount) return res.status(400).json({ error: 'Missing fields' });
        if (!['kpay', 'wavepay', 'binance'].includes(method)) return res.status(400).json({ error: 'Invalid payment method' });

        const withdrawalAmount = Number(amount);
        if (isNaN(withdrawalAmount) || withdrawalAmount <= 0) return res.status(400).json({ error: 'Invalid amount' });

        const minWithdraw = await getConfig('MIN_WITHDRAWAL');
        if (withdrawalAmount < minWithdraw) return res.status(400).json({ error: `Minimum withdrawal is ${minWithdraw} coins` });

        const user = await getOrCreateUser(req.tgUser);
        if (user.banned) return res.status(403).json({ error: 'Banned' });
        if (user.coins < withdrawalAmount) return res.status(400).json({ error: 'Insufficient balance' });

        user.coins -= withdrawalAmount;
        await user.save();

        const fullAccountDetails = `${accountDetails} ${accountName ? `(${accountName})` : ''}`;
        const withdrawal = new Withdrawal({
            userId: user.userId,
            amount: withdrawalAmount,
            method,
            accountDetails: fullAccountDetails
        });
        await withdrawal.save();

        res.json({ success: true, remainingCoins: user.coins });
    } catch (err) {
        console.error('❌ Error in /api/withdraw:', err);
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

// ==================== PUBLIC UI CONFIG ====================
app.get('/api/ui-config', async (req, res) => {
    try {
        await connectToDatabase();
        const keys = [
            'VIP_CARD_VISIBLE', 'CURRENCY_MODE',
            'CHANNEL_URL', 'CHANNEL_JOIN_REQUIRED', 'VPN_MODE',
            'DAILY_CHECKIN_LABEL', 'DAILY_CHECKIN_REWARD_LABEL',
            'TASK1_LABEL', 'TASK1_REWARD_LABEL', 'TASK1_BTN_LABEL',
            'TASK2_LABEL', 'TASK2_REWARD_LABEL', 'TASK2_BTN_LABEL',
            'TASK3_LABEL', 'TASK3_REWARD_LABEL', 'TASK3_BTN_LABEL',
            'TASK4_LABEL', 'TASK4_REWARD_LABEL', 'TASK4_BTN_LABEL',
            'EARN_REWARD_LABEL', 'EARN_WATCH_LABEL',
            'REFERRAL_REWARD', 'MIN_WITHDRAWAL', 'DAILY_REWARD', 'TASK_REWARD', 'HOME_TASK_REWARD'
        ];
        const result = {};
        for (const k of keys) result[k] = await getConfig(k);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== LEADERBOARD (Top 5 by Coins) ====================
app.get('/api/leaderboard', async (req, res) => {
    try {
        await connectToDatabase();
        const users = await User.find({ banned: false })
            .sort({ coins: -1 })
            .limit(5)
            .select('userId username firstName photoUrl coins')
            .lean();

        const leaderboard = users.map((user, index) => {
            let fullName = user.username || user.firstName;
            if (!fullName) {
                const userIdStr = user.userId.toString();
                fullName = `User${userIdStr.slice(-4)}`;
            }
            // Truncate: skip first char, show rest (yoonthitsar -> thitsar)
            let name = fullName;
            if (fullName.length > 5) {
                // Find first uppercase or split point after char 1
                const withoutFirst = fullName.slice(1);
                const upperMatch = withoutFirst.match(/[A-Z]/);
                if (upperMatch) {
                    name = fullName.slice(fullName.indexOf(upperMatch[0], 1));
                } else {
                    // No uppercase: show last 60% of the name
                    name = fullName.slice(Math.ceil(fullName.length * 0.4));
                }
            }
            return {
                rank: index + 1,
                name: name,
                fullName: fullName,
                photo: user.photoUrl || null,
                totalCoins: user.coins
            };
        });

        res.json(leaderboard);
    } catch (err) {
        console.error('❌ Error in /api/leaderboard:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// ==================== TOP REFERRERS ====================
app.get('/api/top-referrers', async (req, res) => {
    try {
        await connectToDatabase();
        const users = await User.find({ banned: false })
            .sort({ referralCount: -1 })
            .limit(5)
            .select('userId username firstName photoUrl referralCount')
            .lean();

        const formatted = users.map(u => ({
            userId: u.userId,
            username: u.username || u.firstName || `User${u.userId}`,
            firstName: u.firstName,
            photoUrl: u.photoUrl,
            referralCount: u.referralCount
        }));

        res.json(formatted);
    } catch (err) {
        console.error('❌ Error in /api/top-referrers:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// ==================== GALAXY ADMIN ROUTES ====================

// Broadcast
app.post('/api/admin/broadcast', adminMiddleware, async (req, res) => {
    try {
        const { message } = req.body;
        if (!message || message.trim() === '') {
            return res.status(400).json({ error: 'Message is required' });
        }
        res.json({ success: true, message: 'Broadcast started.' });
        // Run broadcast async in background
        (async () => {
            try {
                await connectToDatabase();
                const users = await User.find({ banned: { $ne: true } }).select('userId').lean();
                console.log(`📢 Broadcasting to ${users.length} users...`);
                let ok = 0, fail = 0;
                for (let i = 0; i < users.length; i += 30) {
                    const batch = users.slice(i, i + 30);
                    await Promise.all(batch.map(async (u) => {
                        try {
                            if (bot && isPolling) {
                                await bot.sendMessage(u.userId, message, { parse_mode: 'HTML' });
                                ok++;
                            }
                        } catch(e) { fail++; }
                    }));
                    if (i + 30 < users.length) await new Promise(r => setTimeout(r, 1500));
                }
                console.log(`✅ Broadcast done. OK: ${ok}, Failed: ${fail}`);
            } catch(e) { console.error('Broadcast error:', e.message); }
        })();
    } catch (err) {
        console.error('❌ Error in /api/admin/broadcast:', err);
        res.status(500).json({ error: 'Failed to start broadcast: ' + err.message });
    }
});

// Get settings
app.get('/api/admin/settings', adminMiddleware, async (req, res) => {
    try {
        await connectToDatabase();
        const settings = await Config.find();
        const settingsObj = {};
        settings.forEach(s => { settingsObj[s.key] = s.value; });
        res.json(settingsObj);
    } catch (err) {
        console.error('❌ Error in /api/admin/settings:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// Update settings
app.post('/api/admin/settings', adminMiddleware, async (req, res) => {
    try {
        await connectToDatabase();
        const updates = req.body;
        for (const [key, value] of Object.entries(updates)) {
            await setConfig(key, value);
        }
        res.json({ success: true });
    } catch (err) {
        console.error('❌ Error in /api/admin/settings:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// Get withdrawals
app.get('/api/admin/withdrawals', adminMiddleware, async (req, res) => {
    try {
        await connectToDatabase();
        const { status, page = 1, limit = 20 } = req.query;
        const filter = {};
        if (status) filter.status = status;
        const skip = (parseInt(page) - 1) * parseInt(limit);
        const withdrawals = await Withdrawal.find(filter)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(parseInt(limit));
        const total = await Withdrawal.countDocuments(filter);
        res.json({ withdrawals, total, page, limit });
    } catch (err) {
        console.error('❌ Error in /api/admin/withdrawals:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// Approve withdrawal
app.post('/api/admin/withdrawals/:id/approve', adminMiddleware, async (req, res) => {
    try {
        await connectToDatabase();
        const withdrawal = await Withdrawal.findById(req.params.id);
        if (!withdrawal) return res.status(404).json({ error: 'Withdrawal not found' });
        if (withdrawal.status !== 'pending') return res.status(400).json({ error: 'Withdrawal already processed' });

        withdrawal.status = 'completed';
        await withdrawal.save();

        await notifyBot('/withdrawal-notify', {
            userId: withdrawal.userId,
            amount: withdrawal.amount,
            method: withdrawal.method,
            status: 'completed'
        });

        res.json({ success: true });
    } catch (err) {
        console.error('❌ Error in approve withdrawal:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// Reject withdrawal with reason
app.post('/api/admin/withdrawals/:id/reject', adminMiddleware, async (req, res) => {
    try {
        await connectToDatabase();
        const { reason } = req.body;
        const withdrawal = await Withdrawal.findById(req.params.id);
        if (!withdrawal) return res.status(404).json({ error: 'Withdrawal not found' });
        if (withdrawal.status !== 'pending') return res.status(400).json({ error: 'Withdrawal already processed' });

        await User.updateOne({ userId: withdrawal.userId }, { $inc: { coins: withdrawal.amount } });

        withdrawal.status = 'rejected';
        withdrawal.rejectReason = reason || null;
        await withdrawal.save();

        await notifyBot('/withdrawal-notify', {
            userId: withdrawal.userId,
            amount: withdrawal.amount,
            method: withdrawal.method,
            status: 'rejected',
            reason: reason || 'No reason provided'
        });

        res.json({ success: true });
    } catch (err) {
        console.error('❌ Error in reject withdrawal:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// Ban user
app.post('/api/admin/users/:userId/ban', adminMiddleware, async (req, res) => {
    try {
        await connectToDatabase();
        const targetId = parseInt(req.params.userId);
        await User.updateOne({ userId: targetId }, { banned: true });
        res.json({ success: true });
    } catch (err) {
        console.error('❌ Error banning user:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// Unban user
app.post('/api/admin/users/:userId/unban', adminMiddleware, async (req, res) => {
    try {
        await connectToDatabase();
        const targetId = parseInt(req.params.userId);
        await User.updateOne({ userId: targetId }, { banned: false });
        res.json({ success: true });
    } catch (err) {
        console.error('❌ Error unbanning user:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// Edit coins (add/subtract)
app.post('/api/admin/users/:userId/coins', adminMiddleware, async (req, res) => {
    try {
        await connectToDatabase();
        const targetId = parseInt(req.params.userId);
        const { delta } = req.body;
        if (typeof delta !== 'number') return res.status(400).json({ error: 'Delta must be a number' });

        const user = await User.findOneAndUpdate(
            { userId: targetId },
            { $inc: { coins: delta } },
            { new: true }
        );
        if (!user) return res.status(404).json({ error: 'User not found' });

        res.json({ success: true, newCoins: user.coins });
    } catch (err) {
        console.error('❌ Error adjusting coins:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// Edit referral count
app.post('/api/admin/users/:userId/referral', adminMiddleware, async (req, res) => {
    try {
        await connectToDatabase();
        const targetId = parseInt(req.params.userId);
        const { delta } = req.body;
        if (typeof delta !== 'number') return res.status(400).json({ error: 'Delta must be a number' });

        const user = await User.findOneAndUpdate(
            { userId: targetId },
            { $inc: { referralCount: delta } },
            { new: true }
        );
        if (!user) return res.status(404).json({ error: 'User not found' });

        res.json({ success: true, newReferralCount: user.referralCount });
    } catch (err) {
        console.error('❌ Error adjusting referral count:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// Reset tasks
app.post('/api/admin/users/:userId/tasks/reset', adminMiddleware, async (req, res) => {
    try {
        await connectToDatabase();
        const targetId = parseInt(req.params.userId);
        const user = await User.findOne({ userId: targetId });
        if (!user) return res.status(404).json({ error: 'User not found' });
        user.tasks = new Map();
        user.videoTasks = new Map();
        user.dailyLastClaim = 0;
        user.dailyVideoCount = 0;
        user.lastVideoDate = null;
        await user.save();
        res.json({ success: true });
    } catch (err) {
        console.error('❌ Error resetting tasks:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// Update user photo (bot only)
app.post('/api/admin/users/:userId/photo', async (req, res) => {
    if (req.headers['x-telegram-init-data'] !== 'bot') {
        return res.status(403).json({ error: 'Forbidden' });
    }

    try {
        await connectToDatabase();
        const targetId = parseInt(req.params.userId);
        const { photoUrl } = req.body;

        await User.updateOne(
            { userId: targetId },
            { $set: { photoUrl: photoUrl || DEFAULT_PHOTO } }
        );

        res.json({ success: true });
    } catch (err) {
        console.error('❌ Error updating user photo:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// Get admin stats
app.get('/api/admin/stats', adminMiddleware, async (req, res) => {
    try {
        await connectToDatabase();
        const totalUsers = await User.countDocuments();
        const bannedUsers = await User.countDocuments({ banned: true });
        const totalWithdrawals = await Withdrawal.countDocuments();
        const pendingWithdrawals = await Withdrawal.countDocuments({ status: 'pending' });
        const completedWithdrawals = await Withdrawal.countDocuments({ status: 'completed' });

        const coinsResult = await User.aggregate([{ $group: { _id: null, total: { $sum: "$coins" } } }]);
        const totalCoins = coinsResult.length > 0 ? coinsResult[0].total : 0;

        const payoutResult = await Withdrawal.aggregate([
            { $match: { status: 'completed' } },
            { $group: { _id: null, total: { $sum: "$amount" } } }
        ]);
        const totalPayout = payoutResult.length > 0 ? payoutResult[0].total : 0;

        res.json({
            totalUsers,
            bannedUsers,
            totalWithdrawals,
            pendingWithdrawals,
            completedWithdrawals,
            totalCoins,
            totalPayout
        });
    } catch (err) {
        console.error('❌ Error in /api/admin/stats:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// ==================== UPDATED: Get all users with isBypassed field ====================
app.get('/api/admin/users', adminMiddleware, async (req, res) => {
    try {
        await connectToDatabase();
        const users = await User.find().sort({ createdAt: -1 }).limit(1000);
        const userList = users.map(u => ({
            userId: u.userId,
            username: u.username || u.firstName || `User${u.userId}`,
            firstName: u.firstName,
            lastName: u.lastName,
            photoUrl: u.photoUrl,
            coins: u.coins,
            dailyLastClaim: u.dailyLastClaim,
            tasks: Object.fromEntries(u.tasks),
            videoTasks: u.videoTasks ? Object.fromEntries(u.videoTasks) : {},
            dailyVideoCount: u.dailyVideoCount,
            lastVideoDate: u.lastVideoDate,
            referralCount: u.referralCount,
            unclaimedReferrals: u.unclaimedReferrals,
            createdAt: u.createdAt,
            banned: u.banned,
            isBypassed: u.isBypassed,
            spinTickets: u.spinTickets,
            adWatchCount: u.adWatchCount,
            lastAdWatch: u.lastAdWatch,
            adCooldownEndTime: u.adCooldownEndTime,
            vipMode: u.vipMode || false,
            vipExpiry: u.vipExpiry || null,
            lastTaskReset: u.lastTaskReset || 0
        }));
        console.log(`✅ Bot fetched ${users.length} users`);
        res.json({ users: userList, total: users.length });
    } catch (err) {
        console.error('❌ Error in /api/admin/users:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

// Earn & Games routes are inlined below

// ==================== Initialize ====================
connectToDatabase()
    .then(async () => {
        console.log('✅ Database connected. API is ready.');
        await initConfigFromEnv();
        // Setup TTL indexes for MongoDB free tier cleanup
        try {
            // Withdrawals: 30 days TTL
            await mongoose.connection.collection('withdrawals').createIndex(
                { createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30, background: true }
            );
            // VIP Purchases: 30 days TTL
            await mongoose.connection.collection('vippurchases').createIndex(
                { createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30, background: true }
            );
            // Auto-cleanup users inactive for 30 days (via lastSeen field if added later)
            console.log('✅ TTL indexes created successfully');
        } catch(e) {
            console.log('⚠️ TTL index setup:', e.message);
        }
    })
    .catch(err => {
        console.error('❌ Initialization error:', err);
    });

// ==================== VIP Purchase Submit ====================
app.post('/api/vip/purchase', authMiddleware, maintenanceCheck, async (req, res) => {
    try {
        await connectToDatabase();
        const { screenshotData, paymentMethod } = req.body;
        if (!screenshotData || !paymentMethod) {
            return res.status(400).json({ error: 'Missing screenshot or payment method' });
        }
        if (!['kpay', 'wave'].includes(paymentMethod)) {
            return res.status(400).json({ error: 'Invalid payment method' });
        }

        const user = await getOrCreateUser(req.tgUser);
        if (user.banned) return res.status(403).json({ error: 'Banned' });

        // Check if already has active VIP
        if (user.vipMode && user.vipExpiry && new Date(user.vipExpiry) > new Date()) {
            return res.status(400).json({ error: 'VIP mode is already active' });
        }

        // Check pending purchase
        const existing = await VipPurchase.findOne({ userId: user.userId, status: 'pending' });
        if (existing) {
            return res.status(400).json({ error: 'Pending purchase already exists. Please wait for admin confirmation.' });
        }

        const purchase = new VipPurchase({
            userId: user.userId,
            username: user.username,
            firstName: user.firstName,
            amount: 5000,
            paymentMethod,
            screenshotData,
            status: 'pending'
        });
        await purchase.save();

        // Notify admin via bot
        const methodName = paymentMethod === 'kpay' ? 'KPay' : 'Wave Pay';
        const userName = user.username ? `@${user.username}` : (user.firstName || `User${user.userId}`);
        if (process.env.RENDER_BOT_URL) {
            axios.post(`${process.env.RENDER_BOT_URL}/vip-purchase-notify`, {
                purchaseId: purchase._id.toString(),
                userId: user.userId,
                userName,
                amount: 5000,
                paymentMethod: methodName,
                screenshotData
            }, { timeout: 10000 }).catch(err => {
                console.error('Failed to notify bot of VIP purchase:', err.message);
            });
        }

        res.json({ success: true, message: 'Purchase request submitted. Admin will confirm shortly.' });
    } catch (err) {
        console.error('❌ Error in /api/vip/purchase:', err);
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

// ==================== VIP Mode Toggle (User side) ====================
app.post('/api/vip/toggle', authMiddleware, maintenanceCheck, async (req, res) => {
    try {
        await connectToDatabase();
        const user = await getOrCreateUser(req.tgUser);
        if (user.banned) return res.status(403).json({ error: 'Banned' });

        // Check VIP expiry
        const now = new Date();
        if (!user.vipMode && (!user.vipExpiry || new Date(user.vipExpiry) <= now)) {
            return res.status(403).json({ error: 'VIP not active. Please purchase VIP first.' });
        }

        // If expired, auto-disable
        if (user.vipExpiry && new Date(user.vipExpiry) <= now) {
            user.vipMode = false;
            user.vipExpiry = null;
            await user.save();
            return res.status(403).json({ error: 'VIP has expired. Please renew.' });
        }

        user.vipMode = !user.vipMode;
        await user.save();

        res.json({ success: true, vipMode: user.vipMode, vipExpiry: user.vipExpiry });
    } catch (err) {
        console.error('❌ Error in /api/vip/toggle:', err);
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

// ==================== VIP Status Check ====================
app.get('/api/vip/status', authMiddleware, async (req, res) => {
    try {
        await connectToDatabase();
        const user = await User.findOne({ userId: req.tgUser.id });
        if (!user) return res.status(404).json({ error: 'User not found' });

        const now = new Date();
        // Auto-expire check
        if (user.vipMode && user.vipExpiry && new Date(user.vipExpiry) <= now) {
            user.vipMode = false;
            await user.save();
            // Notify bot to send expiry message
            if (process.env.RENDER_BOT_URL) {
                axios.post(`${process.env.RENDER_BOT_URL}/vip-expired-notify`, {
                    userId: user.userId
                }, { timeout: 5000 }).catch(() => {});
            }
        }

        res.json({
            vipMode: user.vipMode || false,
            vipExpiry: user.vipExpiry || null,
            isExpired: user.vipExpiry ? new Date(user.vipExpiry) <= now : true
        });
    } catch (err) {
        console.error('❌ Error in /api/vip/status:', err);
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

// ==================== Admin: Confirm VIP Purchase ====================
app.post('/api/admin/vip/:purchaseId/confirm', adminMiddleware, async (req, res) => {
    try {
        await connectToDatabase();
        const purchase = await VipPurchase.findById(req.params.purchaseId);
        if (!purchase) return res.status(404).json({ error: 'Purchase not found' });
        if (purchase.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

        purchase.status = 'confirmed';
        await purchase.save();

        // Set VIP mode for user - 30 days
        const expiry = new Date();
        expiry.setDate(expiry.getDate() + 30);

        await User.updateOne(
            { userId: purchase.userId },
            { vipMode: true, vipExpiry: expiry }
        );

        // Notify user via bot
        if (process.env.RENDER_BOT_URL) {
            axios.post(`${process.env.RENDER_BOT_URL}/vip-confirmed-notify`, {
                userId: purchase.userId,
                expiry: expiry.toISOString()
            }, { timeout: 5000 }).catch(() => {});
        }

        res.json({ success: true, message: 'VIP confirmed for 30 days', expiry });
    } catch (err) {
        console.error('❌ Error confirming VIP:', err);
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

// ==================== Admin: Reject VIP Purchase ====================
app.post('/api/admin/vip/:purchaseId/reject', adminMiddleware, async (req, res) => {
    try {
        await connectToDatabase();
        const purchase = await VipPurchase.findById(req.params.purchaseId);
        if (!purchase) return res.status(404).json({ error: 'Purchase not found' });
        if (purchase.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

        purchase.status = 'rejected';
        await purchase.save();

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

// ==================== Admin: Get VIP Purchases ====================
app.get('/api/admin/vip/purchases', adminMiddleware, async (req, res) => {
    try {
        await connectToDatabase();
        const purchases = await VipPurchase.find({ status: 'pending' }).sort({ createdAt: -1 }).limit(50);
        res.json({ purchases });
    } catch (err) {
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

// ==================== Admin: Set VIP for User Manually ====================
app.post('/api/admin/users/:userId/vip', adminMiddleware, async (req, res) => {
    try {
        await connectToDatabase();
        const targetId = parseInt(req.params.userId);
        const { enable } = req.body;

        const user = await User.findOne({ userId: targetId });
        if (!user) return res.status(404).json({ error: 'User not found' });

        if (enable) {
            const expiry = new Date();
            expiry.setDate(expiry.getDate() + 30);
            user.vipMode = true;
            user.vipExpiry = expiry;
        } else {
            user.vipMode = false;
            user.vipExpiry = null;
        }
        await user.save();

        // Notify user via bot if enabling
        if (enable && process.env.RENDER_BOT_URL) {
            axios.post(`${process.env.RENDER_BOT_URL}/vip-confirmed-notify`, {
                userId: user.userId,
                expiry: user.vipExpiry?.toISOString()
            }, { timeout: 5000 }).catch(() => {});
        }

        res.json({ success: true, vipMode: user.vipMode, vipExpiry: user.vipExpiry });
    } catch (err) {
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

// ==================== User: Global Reset All Tasks ====================
// Regular users: 20-min cooldown | VIP users: 10-min cooldown (auto-called by frontend)
app.post('/api/user/reset-tasks', authMiddleware, maintenanceCheck, async (req, res) => {
    try {
        await connectToDatabase();
        const user = await getOrCreateUser(req.tgUser);
        if (user.banned) return res.status(403).json({ error: 'Banned' });

        const now = Date.now();
        const isVip = user.vipMode && user.vipExpiry && new Date(user.vipExpiry) > new Date();
        const cooldownMs = isVip ? 10 * 60 * 1000 : 20 * 60 * 1000;
        const lastReset = user.lastTaskReset || 0;
        const GRACE_MS = 5000;

        if (now - lastReset < cooldownMs - GRACE_MS) {
            return res.status(400).json({
                error: 'Cooldown not elapsed',
                remaining: cooldownMs - (now - lastReset),
                cooldownMs
            });
        }

        // Reset home tasks (tasks map — task1 to task4)
        user.tasks = new Map();
        user.markModified('tasks');

        // Reset earn tasks (videoTasks map — task1 to task7)
        const EARN_TASK_IDS = ['task1','task2','task3','task4','task5','task6','task7'];
        if (!user.videoTasks) user.videoTasks = new Map();
        EARN_TASK_IDS.forEach(tid => {
            user.videoTasks.set(tid, { count: 0, lastClaim: 0, firstClaimTime: 0 });
        });
        user.markModified('videoTasks');

        user.lastTaskReset = now;
        await user.save();

        console.log(`🔄 User ${req.tgUser.id} reset ALL tasks (VIP: ${isVip}). cooldown: ${cooldownMs/60000}min`);
        res.json({ success: true, lastTaskReset: now, cooldownMs, isVip });
    } catch (err) {
        console.error('❌ Error in /api/user/reset-tasks:', err);
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

// ═══════════════════════════════════════════════════════
// EARN ROUTES — inlined from routes/earn.js
// ═══════════════════════════════════════════════════════
(function() {
// earn authMiddleware applied via app.use wrapper below
const earnRouter = (function() {
    const R = require('express').Router();

// ==================== Task 7 ခု, maxCount=4, between-watch cooldown=1min, reset=10min ====================
// reward loaded dynamically from DB config (TASK_REWARD), default 40
const TASK_BASE = { maxCount: 4, watchCooldown: 60 * 1000, dailyCooldown: 10 * 60 * 1000 }; // 10-minute reset
const VIDEO_TASK_LIMITS = {
    task1: { ...TASK_BASE, reward: 40, blockId: '23898' },
    task2: { ...TASK_BASE, reward: 40, blockId: '23919' },
    task3: { ...TASK_BASE, reward: 40, blockId: '24540' },
    task4: { ...TASK_BASE, reward: 40, blockId: '24541' },
    task5: { ...TASK_BASE, reward: 40, blockId: '24542' },
    task6: { ...TASK_BASE, reward: 40, blockId: '24543' },
    task7: { ...TASK_BASE, reward: 40, blockId: '24544' }
};

async function getEarnTaskReward() {
    try {
        const Config = mongoose.model('Config');
        const cfg = await Config.findOne({ key: 'TASK_REWARD' });
        return (cfg && typeof cfg.value === 'number') ? cfg.value : 40;
    } catch(e) { return 40; }
}

async function getHomeTaskReward() {
    try {
        const Config = mongoose.model('Config');
        const cfg = await Config.findOne({ key: 'HOME_TASK_REWARD' });
        return (cfg && typeof cfg.value === 'number') ? cfg.value : 45;
    } catch(e) { return 45; }
}

const VALID_TASK_IDS = Object.keys(VIDEO_TASK_LIMITS);

// ==================== Helper ====================
function getTodayStart() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

// ==================== GET /api/earn/tasks/status ====================
R.get('/tasks/status', async (req, res) => {
    try {
        if (!req.tgUser) return res.status(401).json({ error: 'User not authenticated' });
        const User = mongoose.model('User');
        const user = await User.findOne({ userId: req.tgUser.id });
        if (!user) return res.status(404).json({ error: 'User not found' });

        const now = Date.now();
        const taskStatus = {};

        const liveReward = await getEarnTaskReward();
        for (const taskId of VALID_TASK_IDS) {
            const cfg = VIDEO_TASK_LIMITS[taskId];
            let taskData = user.videoTasks?.get(taskId) || { count: 0, lastClaim: 0, firstClaimTime: 0 };

            // 2hr daily reset: if firstClaimTime > 0 and 2hr passed, reset count
            if (taskData.firstClaimTime && taskData.firstClaimTime > 0) {
                if (now - taskData.firstClaimTime >= cfg.dailyCooldown) {
                    taskData = { count: 0, lastClaim: 0, firstClaimTime: 0 };
                }
            }

            // time until daily reset
            let dailyResetIn = 0;
            if (taskData.firstClaimTime && taskData.firstClaimTime > 0 && taskData.count >= cfg.maxCount) {
                dailyResetIn = Math.max(0, cfg.dailyCooldown - (now - taskData.firstClaimTime));
            }

            // between-watch cooldown (1 min after each watch)
            const watchCooldownRemaining = taskData.lastClaim
                ? Math.max(0, cfg.watchCooldown - (now - taskData.lastClaim))
                : 0;

            taskStatus[taskId] = {
                currentCount: taskData.count,
                maxCount: cfg.maxCount,
                reward: liveReward,
                blockId: cfg.blockId,
                lastClaim: taskData.lastClaim,
                firstClaimTime: taskData.firstClaimTime || 0,
                watchCooldownRemaining,    // ms until next watch allowed (1 min)
                dailyResetIn,             // ms until 0/4 resets (2hr from first claim)
                canClaim: taskData.count < cfg.maxCount && watchCooldownRemaining === 0
            };
        }

        res.json({ success: true, tasks: taskStatus });
    } catch (err) {
        console.error('❌ Error in /api/earn/tasks/status:', err);
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

// ==================== POST /api/earn/video ====================
R.post('/video', async (req, res) => {
    try {
        if (!req.tgUser) return res.status(401).json({ error: 'User not authenticated' });

        const { taskId, amount } = req.body;
        if (!taskId || !VALID_TASK_IDS.includes(taskId)) return res.status(400).json({ error: 'Invalid task ID' });

        const cfg = VIDEO_TASK_LIMITS[taskId];
        const liveReward = await getEarnTaskReward();
        // amount check removed — reward is determined server-side

        const User = mongoose.model('User');
        const user = await User.findOne({ userId: req.tgUser.id });
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.banned) return res.status(403).json({ error: 'Your account is banned' });

        if (!user.videoTasks) user.videoTasks = new Map();

        const now = Date.now();
        let taskData = user.videoTasks.get(taskId) || { count: 0, lastClaim: 0, firstClaimTime: 0 };

        // 2hr daily reset check
        if (taskData.firstClaimTime && taskData.firstClaimTime > 0) {
            if (now - taskData.firstClaimTime >= cfg.dailyCooldown) {
                taskData = { count: 0, lastClaim: 0, firstClaimTime: 0 };
            }
        }

        // Check maxCount
        if (taskData.count >= cfg.maxCount) {
            const resetIn = Math.max(0, cfg.dailyCooldown - (now - taskData.firstClaimTime));
            return res.status(400).json({ error: 'Daily limit reached', resetIn, taskId });
        }

        // Check 1 min between-watch cooldown
        if (taskData.lastClaim && now - taskData.lastClaim < cfg.watchCooldown) {
            const remaining = Math.ceil((cfg.watchCooldown - (now - taskData.lastClaim)) / 1000);
            return res.status(400).json({ error: 'Cooldown period', remaining, taskId });
        }

        // Update
        taskData.count += 1;
        taskData.lastClaim = now;
        if (!taskData.firstClaimTime || taskData.firstClaimTime === 0) {
            taskData.firstClaimTime = now; // record first claim time for 2hr reset
        }

        user.videoTasks.set(taskId, taskData);
        user.coins += liveReward;
        await user.save();

        console.log(`✅ User ${req.tgUser.id} earned ${liveReward} coins from ${taskId} (${taskData.count}/${cfg.maxCount}). Total: ${user.coins}`);

        res.json({
            success: true,
            newCoins: user.coins,
            taskId,
            currentCount: taskData.count,
            maxCount: cfg.maxCount,
            reward: liveReward,
            lastClaim: taskData.lastClaim,
            firstClaimTime: taskData.firstClaimTime
        });
    } catch (err) {
        console.error('❌ Error in /api/earn/video:', err);
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

// ==================== POST /api/earn/reset-task ====================
// Called by frontend when the 10-minute timer expires — resets a single task's
// count/lastClaim/firstClaimTime back to zero so the user can watch again.
R.post('/reset-task', async (req, res) => {
    try {
        if (!req.tgUser) return res.status(401).json({ error: 'User not authenticated' });

        const { taskId } = req.body;
        if (!taskId || !VALID_TASK_IDS.includes(taskId)) {
            return res.status(400).json({ error: 'Invalid task ID' });
        }

        const User = mongoose.model('User');
        const user = await User.findOne({ userId: req.tgUser.id });
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.banned) return res.status(403).json({ error: 'Your account is banned' });

        const now = Date.now();
        const cfg = VIDEO_TASK_LIMITS[taskId];
        const taskData = user.videoTasks?.get(taskId) || { count: 0, lastClaim: 0, firstClaimTime: 0 };

        // Only reset if the 10-minute cooldown has actually elapsed (server-side guard)
        if (taskData.firstClaimTime && taskData.firstClaimTime > 0) {
            const elapsed = now - taskData.firstClaimTime;
            if (elapsed < cfg.dailyCooldown - 5000) { // 5s grace
                const resetIn = Math.ceil((cfg.dailyCooldown - elapsed) / 1000);
                return res.status(400).json({ error: 'Reset cooldown not elapsed', resetIn });
            }
        }

        // Reset this task
        user.videoTasks.set(taskId, { count: 0, lastClaim: 0, firstClaimTime: 0 });
        await user.save();

        console.log(`🔄 User ${req.tgUser.id} reset task ${taskId}`);
        res.json({ success: true, taskId });
    } catch (err) {
        console.error('❌ Error in /api/earn/reset-task:', err);
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

console.log('✅ earn.js router loaded successfully');

    return R;
})();
app.use('/api/earn', authMiddleware, maintenanceCheck, earnRouter);
})();

// ═══════════════════════════════════════════════════════
// GAMES ROUTES — inlined from routes/games.js
// ═══════════════════════════════════════════════════════
(function() {
const gamesRouter = (function() {
    const R = require('express').Router();

// ==================== Define User Schema ====================
const DEFAULT_PHOTO = 'https://raw.githubusercontent.com/ggfjhdssd/noomcoin-telegram-app/main/public/images/fa6a539141b9eeae723f551b9d67b875.jpg';

const userSchema = new mongoose.Schema({
    userId: { type: Number, required: true, unique: true },
    username: String,
    firstName: String,
    lastName: String,
    photoUrl: { type: String, default: DEFAULT_PHOTO },
    coins: { type: Number, default: 0 },
    dailyLastClaim: { type: Number, default: 0 },
    tasks: { type: Map, of: Number, default: {} },
    videoTasks: { type: Map, of: {
        count: Number,
        lastClaim: Number,
        date: Number
    }, default: {} },
    dailyVideoCount: { type: Number, default: 0 },
    lastVideoDate: { type: Date, default: null },
    referredBy: { type: Number, default: null },
    referralCount: { type: Number, default: 0 },
    unclaimedReferrals: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
    banned: { type: Boolean, default: false },
    spinTickets: { type: Number, default: 1 },
    adWatchCount: { type: Number, default: 0 },
    lastAdWatch: { type: Number, default: 0 },
    adCooldownEndTime: { type: Number, default: 0 },
    gameSession: {
        active: { type: Boolean, default: false },
        startTime: { type: Number, default: 0 },
        tempScore: { type: Number, default: 0 }
    }
});

const User = mongoose.models.User || mongoose.model('User', userSchema);

// ==================== Spin Wheel Prizes ====================
// Prizes: 8 segments — index matches wheel segment order
// Segment order (clockwise from top): 10, 20, 50, 70, 85, 100, Free, TryAgain
const PRIZES = [
    { name: '10 coins',  value: 10,  type: 'coin',     probability: 25 }, // index 0
    { name: '20 coins',  value: 20,  type: 'coin',     probability: 20 }, // index 1
    { name: '50 coins',  value: 50,  type: 'coin',     probability: 15 }, // index 2
    { name: '70 coins',  value: 70,  type: 'coin',     probability: 12 }, // index 3
    { name: '85 coins',  value: 85,  type: 'coin',     probability: 10 }, // index 4
    { name: '100 coins', value: 100, type: 'coin',     probability: 8  }, // index 5
    { name: 'Free Spin', value: 1,   type: 'freespin', probability: 5  }, // index 6
    { name: 'Try Again', value: 0,   type: 'tryagain', probability: 5  }  // index 7
];

// ==================== Constants ====================
const TWO_HOURS = 2 * 60 * 60 * 1000; // 2 hours in milliseconds
const THREE_SECONDS = 3000;

// ==================== Spin Wheel Routes ====================
R.get('/tickets', async (req, res) => {
    try {
        const user = await User.findOne({ userId: req.tgUser.id });
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json({ tickets: user.spinTickets });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

R.post('/spin', async (req, res) => {
    try {
        const user = await User.findOne({ userId: req.tgUser.id });
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.spinTickets < 1) return res.status(400).json({ error: 'No tickets left' });

        const rand = Math.random() * 100;
        let cumulative = 0;
        let selectedPrize = null;
        let selectedIndex = -1;
        
        for (let i = 0; i < PRIZES.length; i++) {
            cumulative += PRIZES[i].probability;
            if (rand < cumulative) {
                selectedPrize = PRIZES[i];
                selectedIndex = i;
                break;
            }
        }

        user.spinTickets -= 1;
        if (selectedPrize.type === 'coin') {
            user.coins += selectedPrize.value;
        } else if (selectedPrize.type === 'freespin') {
            user.spinTickets += 1;
        }

        await user.save();
        res.json({
            prize: selectedPrize.name,
            prizeIndex: selectedIndex,
            type: selectedPrize.type,
            value: selectedPrize.value,
            newCoins: user.coins,
            newTickets: user.spinTickets
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== POST /api/games/watch-ad ====================
R.post('/watch-ad', async (req, res) => {
    try {
        const user = await User.findOne({ userId: req.tgUser.id });
        if (!user) return res.status(404).json({ error: 'User not found' });

        const now = Date.now();

        // 1. STRICT Cooldown Check - Cooldown ရှိရင် ချက်ချင်း Block
        if (user.adCooldownEndTime && user.adCooldownEndTime > now) {
            return res.status(400).json({ 
                error: 'Cooldown active', 
                cooldownEndTime: user.adCooldownEndTime 
            });
        }

        // 2. Limit Check - ၅ ကြိမ်ပြည့်နေရင် ထပ်မကြည့်ရ
        if (user.adWatchCount >= 5) {
            return res.status(400).json({ error: 'You have already watched 5 ads. Please claim your ticket first.' });
        }

        // 3. 3-second cooldown between ads
        if (user.lastAdWatch && (now - user.lastAdWatch) < THREE_SECONDS) {
            const remainingMs = THREE_SECONDS - (now - user.lastAdWatch);
            const remainingSec = Math.ceil(remainingMs / 1000);
            return res.status(400).json({ 
                error: `Please wait ${remainingSec} seconds between ads.`,
                remaining: remainingSec
            });
        }

        // Increment ad watch count
        user.adWatchCount += 1;
        user.lastAdWatch = now;

        await user.save();

        res.json({
            adWatchCount: user.adWatchCount,
            tickets: user.spinTickets,
            cooldownEndTime: user.adCooldownEndTime,
            lastAdWatch: user.lastAdWatch,
            message: 'Ad watched successfully'
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== POST /api/games/claim-ticket ====================
R.post('/claim-ticket', async (req, res) => {
    try {
        const user = await User.findOne({ userId: req.tgUser.id });
        if (!user) return res.status(404).json({ error: 'User not found' });

        const now = Date.now();

        // Cannot claim if already in cooldown
        if (user.adCooldownEndTime && user.adCooldownEndTime > now) {
            return res.status(400).json({ error: 'You are already in cooldown period.' });
        }

        // Must have watched at least 5 ads
        if (user.adWatchCount < 5) {
            return res.status(400).json({ error: 'You need to watch 5 ads first.' });
        }

        // Give 1 spin ticket
        user.spinTickets += 1;

        // Reset adWatchCount to 0
        user.adWatchCount = 0;

        // Set 2-hour cooldown (STRICT)
        user.adCooldownEndTime = now + TWO_HOURS;

        await user.save();

        res.json({
            success: true,
            tickets: user.spinTickets,
            adWatchCount: user.adWatchCount,
            cooldownEndTime: user.adCooldownEndTime,
            message: 'Ticket claimed! 2-hour cooldown started.'
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== GET /api/games/ad-status ====================
// ==================== GET /api/games/wheel-status (combined) ====================
R.get('/wheel-status', async (req, res) => {
    try {
        const user = await User.findOne({ userId: req.tgUser.id });
        if (!user) return res.status(404).json({ error: 'User not found' });
        const now = Date.now();
        const claimableReferralTickets = Math.floor((user.unclaimedReferrals || 0) / 5);
        res.json({
            success: true,
            spinTickets: user.spinTickets || 0,
            adWatchCount: user.adWatchCount || 0,
            adCooldownEndTime: user.adCooldownEndTime || 0,
            claimableReferralTickets,
            totalReferrals: user.referralCount || 0,
            unclaimedReferrals: user.unclaimedReferrals || 0,
            serverTime: now
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

R.get('/ad-status', async (req, res) => {
    try {
        const user = await User.findOne({ userId: req.tgUser.id });
        if (!user) return res.status(404).json({ error: 'User not found' });

        const now = Date.now();

        res.json({
            adWatchCount: user.adWatchCount,
            dailyLimit: 5,
            lastAdWatch: user.lastAdWatch,
            cooldownEndTime: user.adCooldownEndTime || 0,
            tickets: user.spinTickets,
            serverTime: now // Frontend က ဒါကိုသုံးပြီး sync လုပ်နိုင်တယ်
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== GET /api/games/invite-status ====================
R.get('/invite-status', async (req, res) => {
    try {
        const user = await User.findOne({ userId: req.tgUser.id });
        if (!user) return res.status(404).json({ error: 'User not found' });

        const claimableTickets = Math.floor(user.unclaimedReferrals / 5);
        const remainingForNext = 5 - (user.unclaimedReferrals % 5);
        res.json({
            referralCount: user.referralCount,
            unclaimedReferrals: user.unclaimedReferrals,
            claimableTickets: claimableTickets,
            remainingForNext: remainingForNext,
            tickets: user.spinTickets,
            message: claimableTickets > 0 
                ? `🎟️ Ticket ${claimableTickets} ခု claim လုပ်နိုင်ပြီ!`
                : `🎁 သူငယ်ချင်း ${remainingForNext} ယောက်ထပ်ဖိတ်ရင် ticket 1 ခုရမည်`
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== POST /api/games/claim-referral-ticket ====================
R.post('/claim-referral-ticket', async (req, res) => {
    try {
        const user = await User.findOne({ userId: req.tgUser.id });
        if (!user) return res.status(404).json({ error: 'User not found' });

        if (user.unclaimedReferrals < 5) {
            return res.status(400).json({ error: 'Not enough unclaimed referrals. Need at least 5.' });
        }

        // Give one ticket
        user.spinTickets += 1;
        // Reduce unclaimedReferrals by 5
        user.unclaimedReferrals -= 5;

        await user.save();

        res.json({
            success: true,
            tickets: user.spinTickets,
            unclaimedReferrals: user.unclaimedReferrals,
            message: 'Ticket claimed!'
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==================== Coin Clicker Routes ====================
const GAME_ENTRY_FEE = 50;   
const GAME_MAX_WIN = 100;

R.post('/coin-start', async (req, res) => {
    try {
        const user = await User.findOne({ userId: req.tgUser.id });
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.coins < GAME_ENTRY_FEE) {
            return res.status(400).json({ error: 'Insufficient coins' });
        }
        user.coins -= GAME_ENTRY_FEE;
        user.gameSession = { active: true, startTime: Date.now(), tempScore: 0 };
        await user.save();
        res.json({ success: true, newBalance: user.coins });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

R.post('/coin-end', async (req, res) => {
    try {
        const { earnedCoins } = req.body;
        if (typeof earnedCoins !== 'number' || earnedCoins < 0 || earnedCoins > GAME_MAX_WIN) {
            return res.status(400).json({ error: 'Invalid earned coins' });
        }
        const user = await User.findOne({ userId: req.tgUser.id });
        if (!user || !user.gameSession.active) return res.status(400).json({ error: 'No active session' });
        user.coins += earnedCoins;
        user.gameSession.active = false;
        await user.save();
        res.json({ success: true, newBalance: user.coins });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


    return R;
})();
app.use('/api/games', authMiddleware, maintenanceCheck, gamesRouter);
})();

// ═══════════════════════════════════════════════════════
// TELEGRAM BOT — inlined from bot.js
// ═══════════════════════════════════════════════════════
const TelegramBot = require('node-telegram-bot-api');

// ==================== Configuration ====================
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEB_APP_URL = 'https://noomcoin.vercel.app';
const ADMIN_PANEL_URL = 'https://noomcoin.vercel.app/admin.html';
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const API_BASE_URL = process.env.API_BASE_URL || 'https://noomcoinbackend.onrender.com';
const SUPPORT_GROUP_ID = -1003748580479;
const SUPPORT_LINK = 'https://t.me/NoomCoinads_bot';

if (!BOT_TOKEN || !ADMIN_ID) {
    console.error('❌ Missing Environment Variables!');
    process.exit(1);
}

// ==================== Global Variables ====================
let bot;
let isPolling = false;
let restartAttempts = 0;
const MAX_RESTART_ATTEMPTS = 5;
let CHANNEL_URL = 'https://t.me/NoomCoinads_bot';
let CHANNEL_JOIN_REQUIRED = true; // Admin can toggle with /off and /on

// ==================== Force clear webhook ====================
async function forceClearWebhook() {
    try {
        console.log('🔄 Force clearing webhook...');
        const res = await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook`);
        console.log('✅ Webhook cleared:', res.data.description);
        return true;
    } catch (err) {
        console.error('❌ Failed to clear webhook:', err.message);
        return false;
    }
}

// ==================== Initialize Bot ====================
async function initializeBot() {
    console.log('🚀 Initializing bot...');
    await forceClearWebhook();
    await new Promise(resolve => setTimeout(resolve, 3000));
    try {
        bot = new TelegramBot(BOT_TOKEN, { polling: true, onlyFirstMatch: true });
        isPolling = true;
        restartAttempts = 0;
        console.log('✅ Bot polling started');
        setupCommandHandlers();
        const me = await bot.getMe();
        console.log(`🤖 Bot connected: @${me.username}`);
    } catch (err) {
        console.error('❌ Failed to initialize bot:', err.message);
        throw err;
    }
}

// ==================== Persist Config via Backend ====================
async function loadPersistedConfig() {
    try {
        const res = await axios.get(`${API_BASE_URL}/api/ui-config`, { timeout: 5000 });
        if (res.data.CHANNEL_JOIN_REQUIRED !== undefined) {
            CHANNEL_JOIN_REQUIRED = res.data.CHANNEL_JOIN_REQUIRED !== false;
        }
        if (res.data.CHANNEL_URL) {
            CHANNEL_URL = res.data.CHANNEL_URL;
        }
        console.log(`✅ Config loaded: joinRequired=${CHANNEL_JOIN_REQUIRED}, channel=${CHANNEL_URL}`);
    } catch (err) {
        console.error('⚠️ Could not load persisted config:', err.message);
    }
}

async function saveConfigToBackend(key, value) {
    try {
        await axios.post(`${API_BASE_URL}/api/admin/settings`,
            { [key]: value },
            { headers: { 'X-Telegram-Init-Data': 'bot' }, timeout: 5000 }
        );
    } catch (err) {
        console.error(`⚠️ Could not save ${key} to backend:`, err.message);
    }
}

// ==================== Channel Join Check ====================
async function checkChannelMembership(userId) {
    if (!CHANNEL_JOIN_REQUIRED) return true; // join check ပိတ်ထားလျှင် skip
    try {
        // Extract channel username from URL: https://t.me/NoomCoin → @NoomCoin
        const urlParts = CHANNEL_URL.replace('https://t.me/', '').replace('http://t.me/', '').replace('t.me/', '');
        const channelUsername = '@' + urlParts.split('/')[0].split('?')[0];
        const member = await bot.getChatMember(channelUsername, userId);
        const status = member.status;
        return ['member', 'administrator', 'creator'].includes(status);
    } catch (err) {
        console.error('❌ Channel membership check failed:', err.message);
        return true; // check fail ဖြစ်ရင် user ကို block မလုပ်ဘဲ ဆက်ခွင့်ပေး
    }
}

// ==================== Command Handlers ====================
function setupCommandHandlers() {
    if (!bot) return;

    // /start with referral + channel join check
    bot.onText(/\/start(?:\s+(\d+))?/, async (msg, match) => {
        console.log('📩 /start command received from user:', msg.from.id);
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const referrerId = match[1];
        let webAppUrl = WEB_APP_URL;
        if (referrerId) {
            webAppUrl = `${WEB_APP_URL}?startapp=${referrerId}`;
            console.log(`🔗 Referral ID detected: ${referrerId}`);
        }
        try {
            // ── Channel join check ──
            if (CHANNEL_JOIN_REQUIRED) {
                const isJoined = await checkChannelMembership(userId);
                if (!isJoined) {
                    // မ join ရသေးဘဲ ─ join ဖိတ်မည်
                    await bot.sendMessage(chatId,
                        `👋 မင်္ဂလာပါ!\n\n` +
                        `🔔 NoomCoin ကိုသုံးရန် အောက်ပါ Channel ကို အရင် Join လုပ်ပါ။\n\n` +
                        `Join ပြီးပြီဆိုရင် *"✅ Joined - စစ်ဆေးပါ"* ကို နှိပ်ပါ။`,
                        {
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '📢 Channel Join လုပ်ရန်', url: CHANNEL_URL }],
                                    [{ text: '✅ Joined - စစ်ဆေးပါ', callback_data: `check_join:${referrerId || ''}` }]
                                ]
                            }
                        }
                    );
                    return;
                }
            }

            // ── Join ဖြစ်ပြီ သို့ join check ပိတ် ─ app ဖွင့်ပေး ──
            await bot.sendMessage(chatId,
                `မင်္ဂလာပါ NoomCoin မှ ကြိုဆိုပါတယ်။ 🎉\n\nဂိမ်းဆော့ပြီးပိုက်ဆံရှာရန် အောက်က ခလုတ်ကို နှိပ်ပါ။`,
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🎮 Play Game', web_app: { url: webAppUrl } }],
                            [{ text: '📢 Join Channel', url: CHANNEL_URL }],
                            [{ text: '💬 Admin ကိုဆက်သွယ်ရန်', url: SUPPORT_LINK }]
                        ]
                    }
                }
            );
            console.log('✅ /start response sent to user:', chatId);
        } catch (err) {
            console.error('❌ /start error:', err.message);
        }
    });

    // ✅ Joined callback - "Joined စစ်ဆေးပါ" button
    bot.on('callback_query', async (query) => {
        const chatId = query.message.chat.id;
        const userId = query.from.id;
        const data = query.data || '';

        if (data.startsWith('check_join:')) {
            const referrerId = data.split(':')[1] || null;
            let webAppUrl = WEB_APP_URL;
            if (referrerId) webAppUrl = `${WEB_APP_URL}?startapp=${referrerId}`;

            await bot.answerCallbackQuery(query.id);

            const isJoined = await checkChannelMembership(userId);
            if (!isJoined) {
                // မ join ရသေးဘူး
                try {
                    await bot.editMessageText(
                        `❌ Channel ကို မ Join ရသေးပါ။\n\nChannel Join ပြီးမှ စစ်ဆေးပါ။`,
                        {
                            chat_id: chatId,
                            message_id: query.message.message_id,
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: '📢 Channel Join လုပ်ရန်', url: CHANNEL_URL }],
                                    [{ text: '✅ Joined - စစ်ဆေးပါ', callback_data: data }]
                                ]
                            }
                        }
                    );
                } catch(e) {}
            } else {
                // Join ဖြစ်ပြီ - app ဖွင့်ပေး
                try {
                    await bot.deleteMessage(chatId, query.message.message_id);
                } catch(e) {}
                await bot.sendMessage(chatId,
                    `✅ Channel join စစ်ဆေးမှု အောင်မြင်ပါပြီ!\n\nမင်္ဂလာပါ NoomCoin မှ ကြိုဆိုပါတယ်။ 🎉\n\nဂိမ်းဆော့ပြီးပိုက်ဆံရှာရန် အောက်က ခလုတ်ကို နှိပ်ပါ။`,
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '🎮 Play Game', web_app: { url: webAppUrl } }],
                                [{ text: '📢 Join Channel', url: CHANNEL_URL }],
                                [{ text: '💬 Admin ကိုဆက်သွယ်ရန်', url: SUPPORT_LINK }]
                            ]
                        }
                    }
                );
            }
        }
    });

    // /admin
    bot.onText(/\/admin/, (msg) => {
        console.log('📩 /admin command received from user:', msg.from.id);
        const chatId = msg.chat.id;
        if (msg.from.id === ADMIN_ID) {
            bot.sendMessage(chatId, '👑 Admin Panel သို့ ဝင်ရန် အောက်က ခလုတ်ကို နှိပ်ပါ။', {
                reply_markup: { inline_keyboard: [[{ text: '👑 Open Admin Panel', web_app: { url: ADMIN_PANEL_URL } }]] }
            }).catch(err => console.error('❌ Admin message error:', err));
        } else {
            bot.sendMessage(chatId, '⛔ You are not Authorized.').catch(err => console.error('❌ Not admin message error:', err));
        }
    });

    // /setchannel
    bot.onText(/\/setchannel (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const newChannelLink = match[1].trim();
        if (msg.from.id !== ADMIN_ID) return bot.sendMessage(chatId, '⛔ ဒီ command ကို Admin မှသာ သုံးလို့ရပါတယ်။');
        if (!newChannelLink.startsWith('https://t.me/') && !newChannelLink.startsWith('http://t.me/') && !newChannelLink.startsWith('t.me/')) {
            return bot.sendMessage(chatId, '❌ မှားယွင်းနေပါတယ်။ Channel link က t.me/ နဲ့ စရပါမယ်။\n\nဥပမာ: /setchannel https://t.me/NoomCoin');
        }
        CHANNEL_URL = newChannelLink;
        await saveConfigToBackend('CHANNEL_URL', CHANNEL_URL);
        const status = CHANNEL_JOIN_REQUIRED ? '🟢 ON (Join လိုအပ်သည်)' : '🔴 OFF (Join မလိုဘူး)';
        await bot.sendMessage(chatId,
            `✅ Channel link ပြောင်းပြီးပါပြီ!\n\n` +
            `📢 Channel: ${CHANNEL_URL}\n` +
            `🔧 Join Check: ${status}`
        );
        console.log(`📢 Admin changed channel link to: ${CHANNEL_URL}`);
    });

    // /off - channel join check ပိတ်မည်
    bot.onText(/\/off$/, async (msg) => {
        const chatId = msg.chat.id;
        if (msg.from.id !== ADMIN_ID) return bot.sendMessage(chatId, '⛔ ဒီ command ကို Admin မှသာ သုံးလို့ရပါတယ်။');
        CHANNEL_JOIN_REQUIRED = false;
        await saveConfigToBackend('CHANNEL_JOIN_REQUIRED', false);
        await bot.sendMessage(chatId,
            `✅ Channel Join Check ကို *ပိတ်လိုက်ပါပြီ*\n\n` +
            `User တွေ channel join မထားလည်း app သုံးလို့ ရပါပြီ။`,
            { parse_mode: 'Markdown' }
        );
        console.log('🔴 Admin disabled channel join requirement');
    });

    // /on - channel join check ဖွင့်မည်
    bot.onText(/\/on$/, async (msg) => {
        const chatId = msg.chat.id;
        if (msg.from.id !== ADMIN_ID) return bot.sendMessage(chatId, '⛔ ဒီ command ကို Admin မှသာ သုံးလို့ရပါတယ်။');
        CHANNEL_JOIN_REQUIRED = true;
        await saveConfigToBackend('CHANNEL_JOIN_REQUIRED', true);
        await bot.sendMessage(chatId,
            `✅ Channel Join Check ကို *ဖွင့်လိုက်ပါပြီ*\n\n` +
            `User တွေ ${CHANNEL_URL} ကို join မှသာ app သုံးနိုင်မည်။`,
            { parse_mode: 'Markdown' }
        );
        console.log('🟢 Admin enabled channel join requirement');
    });

    // /status - current settings ကြည့်ရန်
    bot.onText(/\/status$/, async (msg) => {
        const chatId = msg.chat.id;
        if (msg.from.id !== ADMIN_ID) return bot.sendMessage(chatId, '⛔ ဒီ command ကို Admin မှသာ သုံးလို့ရပါတယ်။');
        const joinStatus = CHANNEL_JOIN_REQUIRED ? '🟢 ON (Join လိုအပ်သည်)' : '🔴 OFF (Join မလိုဘူး)';
        await bot.sendMessage(chatId,
            `📊 *Bot Status*\n\n` +
            `📢 Channel: ${CHANNEL_URL}\n` +
            `🔧 Join Check: ${joinStatus}`,
            { parse_mode: 'Markdown' }
        );
    });

    // /help - admin commands list
    bot.onText(/\/help$/, async (msg) => {
        const chatId = msg.chat.id;
        if (msg.from.id !== ADMIN_ID) return bot.sendMessage(chatId, '⛔ ဒီ command ကို Admin မှသာ သုံးလို့ရပါတယ်။');
        await bot.sendMessage(chatId,
            `👑 *Admin Commands*\n\n` +
            `📢 *Channel စီမံခန့်ခွဲမှု*\n` +
            `/setchannel [link] — Channel link ပြောင်းရန်\n` +
            `   ဥပမာ: /setchannel https://t.me/NewChannel\n\n` +
            `/on — Channel join check ဖွင့်ရန်\n` +
            `/off — Channel join check ပိတ်ရန် (user တွေ join မလုပ်ဘဲ သုံးလို့ရ)\n` +
            `/status — လက်ရှိ settings ကြည့်ရန်\n\n` +
            `👤 *User စီမံခန့်ခွဲမှု*\n` +
            `/admin — Admin panel ဖွင့်ရန်\n` +
            `/reply [userId] [message] — User ကို reply ပေးရန်\n\n` +
            `📌 *လက်ရှိ Settings*\n` +
            `Channel: ${CHANNEL_URL}\n` +
            `Join Check: ${CHANNEL_JOIN_REQUIRED ? '🟢 ON' : '🔴 OFF'}`,
            { parse_mode: 'Markdown' }
        );
    });

    // Forward user messages to support group
    bot.on('message', async (msg) => {
        if (msg.text && msg.text.startsWith('/')) return;
        if (msg.from.id === ADMIN_ID) return;
        if (msg.text) {
            try {
                console.log(`📨 Forwarding message from user ${msg.from.id} to support group`);
                const forwardMessage =
                    `📩 *New Support Message*\n\n` +
                    `👤 *User:* ${msg.from.first_name || ''} ${msg.from.last_name || ''}\n` +
                    `🆔 *User ID:* \`${msg.from.id}\`\n` +
                    `📝 *Message:*\n${msg.text}\n\n` +
                    `_Reply to this user by sending a message starting with /reply ${msg.from.id}_`;
                await bot.sendMessage(SUPPORT_GROUP_ID, forwardMessage, { parse_mode: 'Markdown' });
                await bot.sendMessage(msg.chat.id, '✅ သင့်စာကို Admin ထံ ပို့ပေးလိုက်ပါပြီ။ မကြာမီ အကြောင်းပြန်ပါမယ်။');
                console.log(`✅ Message from user ${msg.from.id} forwarded to group`);
            } catch (err) {
                console.error('❌ Failed to forward message to group:', err.message);
                await bot.sendMessage(msg.chat.id, '❌ စာပို့ရာတွင် အဆင်မပြေမှုရှိသွားပါသည်။ နောက်မှ ထပ်ကြိုးစားကြည့်ပါ။');
            }
        }
    });

    // /reply
    bot.onText(/\/reply (\d+) (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        if (msg.from.id !== ADMIN_ID && chatId !== SUPPORT_GROUP_ID) {
            return bot.sendMessage(chatId, '⛔ ဒီ command ကို Admin မှသာ သုံးလို့ရပါတယ်။');
        }
        const targetUserId = parseInt(match[1]);
        const replyMessage = match[2];
        try {
            await bot.sendMessage(targetUserId,
                `📨 *Admin ထံမှ အကြောင်းပြန်စာ*\n\n${replyMessage}\n\n` +
                `_ပြဿနာရှိပါက ထပ်မံမေးမြန်းနိုင်ပါတယ်။_`,
                { parse_mode: 'Markdown' }
            );
            await bot.sendMessage(chatId, `✅ စာကို ပြန်ပို့ပြီးပါပြီ။`);
            console.log(`📨 Admin replied to user ${targetUserId}`);
        } catch (err) {
            console.error(`❌ Failed to reply to user ${targetUserId}:`, err.message);
            await bot.sendMessage(chatId, `❌ စာပြန်မရပါ။ User က Bot ကို block ထားတာ ဖြစ်နိုင်ပါတယ်။`);
        }
    });

    // Polling error handler
    bot.on('polling_error', async (error) => {
        console.error('❌ Polling error:', error.message);
        if (error.message.includes('409') || error.message.includes('Conflict')) {
            console.log('🔄 409 Conflict detected - restarting bot...');
            restartAttempts++;
            if (restartAttempts > MAX_RESTART_ATTEMPTS) {
                console.error('❌ Too many restart attempts, exiting...');
                process.exit(1);
            }
            try {
                if (isPolling) { await bot.stopPolling(); isPolling = false; console.log('✅ Polling stopped'); }
                await forceClearWebhook();
                await new Promise(resolve => setTimeout(resolve, 5000));
                await initializeBot();
            } catch (e) {
                console.error('❌ Recovery failed:', e.message);
            }
        }
    });
}

// ==================== Helper: Fetch Config ====================
async function getConfig(key) {
    try {
        const res = await axios.get(`${API_BASE_URL}/api/admin/settings`, {
            headers: { 'X-Telegram-Init-Data': 'bot' },
            timeout: 5000
        });
        return res.data[key];
    } catch (err) {
        console.error('Failed to fetch config:', err.message);
        return null;
    }
}

// ==================== Express Server ====================
const botApp = express();
// 20mb limit — base64 screenshot payloads for VIP purchase need large body size
app.use(express.json({ limit: '20mb' }));

botApp.get('/', (req, res) => res.send('🤖 NoomCoin Bot is Running!'));
app.get('/health', (req, res) => res.send('OK'));
app.get('/status', (req, res) => res.json({ status: 'ok', polling: isPolling, channelUrl: CHANNEL_URL, timestamp: new Date().toISOString() }));

// ==================== Fetch Profile Photo ====================
botApp.post('/fetch-photo', async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });
    try {
        if (!bot || !isPolling) return res.status(503).json({ error: 'Bot not ready' });
        const photos = await bot.getUserProfilePhotos(userId, { limit: 1 });
        let photoUrl = null;
        if (photos.total_count > 0) {
            const fileId = photos.photos[0][0].file_id;
            const file = await bot.getFile(fileId);
            photoUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
        }
        await axios.post(`${API_BASE_URL}/api/admin/users/${userId}/photo`, { photoUrl }, {
            headers: { 'X-Telegram-Init-Data': 'bot' },
            timeout: 5000
        });
        res.json({ success: true, photoUrl });
    } catch (err) {
        console.error('Error fetching photo:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== Broadcast ====================
app.post('/broadcast', async (req, res) => {
    const { message, adminId } = req.body;
    if (adminId !== ADMIN_ID) return res.status(403).json({ error: 'Unauthorized' });
    if (!bot || !isPolling) return res.status(503).json({ error: 'Bot not ready' });
    res.status(202).json({ status: 'started' });
    (async () => {
        console.log('📢 Broadcast started...');
        let successCount = 0, failCount = 0;
        try {
            const usersRes = await axios.get(`${API_BASE_URL}/api/admin/users`, {
                headers: { 'X-Telegram-Init-Data': 'bot' }, timeout: 15000
            });
            const users = usersRes.data.users || [];
            console.log(`👥 Total users to broadcast: ${users.length}`);
            for (let i = 0; i < users.length; i += 50) {
                const batch = users.slice(i, i + 50);
                await Promise.all(batch.map(async (user) => {
                    try { await bot.sendMessage(user.userId, message, { parse_mode: 'HTML' }); successCount++; }
                    catch (err) { console.error(`Failed to send to user ${user.userId}:`, err.message); failCount++; }
                }));
                if (i + 50 < users.length) await new Promise(r => setTimeout(r, 3000));
            }
            console.log(`✅ Broadcast completed. Success: ${successCount}, Failed: ${failCount}`);
        } catch (err) { console.error('Broadcast error:', err); }
    })();
});

// ==================== Withdrawal Notification ====================
app.post('/withdrawal-notify', async (req, res) => {
    const { userId, amount, method, status, reason, adminId } = req.body;
    if (adminId !== ADMIN_ID) return res.status(403).json({ error: 'Unauthorized' });
    if (!userId || !amount || !status) return res.status(400).json({ error: 'Missing required fields' });
    if (!bot || !isPolling) return res.status(503).json({ error: 'Bot not ready' });
    try {
        const now = new Date().toLocaleString('my-MM', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        let message;
        if (status === 'completed') {
            message =
                `🎊 *ငွေထုတ်ယူမှု အောင်မြင်ပါသည်။* 🎊\n\n` +
                `လူကြီးမင်း တောင်းဆိုထားသော ငွေထုတ်ယူမှု (Withdrawal) အား စစ်ဆေးပြီး ` +
                `သင်၏ ငွေလွှဲအကောင့်ထဲသို့ ငွေများ အောင်မြင်စွာ လွှဲပြောင်းပေးပြီး ဖြစ်ပါသည်။ 💸\n\n` +
                `📝 *အချက်အလက်များ:*\n━━━━━━━━━━━━━━━━━━\n` +
                `💰 *ပမာဏ:* \`${amount} Coins\`\n` +
                `🏦 *နည်းလမ်း:* ${method ? method.toUpperCase() : 'N/A'}\n` +
                `🕒 *အချိန်:* ${now}\n━━━━━━━━━━━━━━━━━━\n\n` +
                `NoomCoin ကို ယုံကြည်စွာ အသုံးပြုပေးသည့်အတွက် ကျေးဇူးတင်ပါသည်။ 🎮✨\n\n` +
                `✅ ငွေလက်ခံရရှိကြောင်းကို သင်၏ Wallet/Bank App တွင် ပြန်လည်စစ်ဆေးပေးပါရန်။`;
        } else if (status === 'rejected') {
            message =
                `❌ *ငွေထုတ်ယူမှု ငြင်းပယ်ခံရပါသည်။*\n\n` +
                `လူကြီးမင်း၏ ငွေထုတ်ယူမှု တောင်းဆိုချက်မှာ အောက်ပါအကြောင်းပြချက်ကြောင့် မအောင်မြင်ပါ။\n\n` +
                `⚠️ *အကြောင်းပြချက်:* \n\`${reason || 'အကြောင်းပြချက် မရှိပါ'}\`\n\n` +
                `💰 *ပြန်အမ်းငွေ:* \`${amount} Coins\` ကို သင့်အကောင့်ထဲသို့ ပြန်လည် ထည့်သွင်းပေးထားပါသည်။\n\n` +
                `━━━━━━━━━━━━━━━━━━\n🕒 *အချိန်:* ${now}\n━━━━━━━━━━━━━━━━━━\n\n` +
                `အချက်အလက်များကို ပြန်လည်စစ်ဆေးပြီးမှသာ နောက်တစ်ကြိမ် ထပ်မံတောင်းဆိုပေးပါရန် မေတ္တာရပ်ခံအပ်ပါသည်။ 🛠️`;
        } else {
            return res.status(400).json({ error: 'Invalid status' });
        }
        await bot.sendMessage(userId, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
        console.log(`✅ Withdrawal notification sent to user ${userId} (${status})`);
        res.json({ success: true });
    } catch (err) {
        console.error('❌ Withdrawal notification error:', err.message);
        if (err.message.includes('blocked')) return res.status(200).json({ success: false, error: 'User has blocked the bot' });
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==================== VIP Purchase Notify (Screenshot → Admin) ====================
// Backend sends JSON with base64 screenshotData
// We convert base64 → Buffer → bot.sendPhoto to admin (same approach as KBZ backend)
botApp.post('/vip-purchase-notify', async (req, res) => {
    const { purchaseId, userId, userName, amount, paymentMethod, screenshotData } = req.body;

    if (!bot || !isPolling) return res.status(503).json({ error: 'Bot not ready' });

    try {
        const caption =
            `👑 *VIP Purchase Request*\n\n` +
            `👤 *User:* ${userName || userId}\n` +
            `🆔 *User ID:* \`${userId}\`\n` +
            `💰 *Amount:* ${amount || 5000} ကျပ်\n` +
            `🏦 *Method:* ${paymentMethod}\n` +
            `🛒 *Purchase ID:* \`${purchaseId}\`\n\n` +
            `Admin Panel မှ confirm ပေးပါ။`;

        if (screenshotData) {
            // base64 (data:image/...;base64,xxx) → Buffer → sendPhoto
            const base64Clean = screenshotData.replace(/^data:image\/\w+;base64,/, '');
            const buffer = Buffer.from(base64Clean, 'base64');
            await bot.sendPhoto(ADMIN_ID, buffer, {
                caption: caption,
                parse_mode: 'Markdown'
            });
            console.log(`✅ VIP purchase screenshot forwarded to admin for user ${userId}`);
        } else {
            await bot.sendMessage(ADMIN_ID, caption, { parse_mode: 'Markdown' });
            console.log(`✅ VIP purchase text notify sent to admin for user ${userId} (no screenshot)`);
        }

        res.json({ success: true });
    } catch (err) {
        console.error('❌ VIP purchase notify error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==================== VIP Expired Notify ====================
botApp.post('/vip-expired-notify', async (req, res) => {
    const { userId } = req.body;
    if (!userId || !bot || !isPolling) return res.status(400).json({ error: 'Missing data or bot not ready' });
    try {
        await bot.sendMessage(parseInt(userId),
            `⏰ *VIP Mode သက်တမ်းကုန်သွားပါပြီ*\n\n` +
            `သင့် VIP Mode တစ်လသက်တမ်းကုန်သွားပါပြီ။\n` +
            `ဆက်လက် VIP Mode ရရှိနိုင်ရန် ထပ်မံဝယ်ယူနိုင်ပါတယ်။ 👑`,
            { parse_mode: 'Markdown' }
        );
        res.json({ success: true });
    } catch (err) {
        console.error('❌ VIP expired notify error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==================== VIP Confirmed Notify ====================
botApp.post('/vip-confirmed-notify', async (req, res) => {
    const { userId } = req.body;
    if (!userId || !bot || !isPolling) return res.status(400).json({ error: 'Missing data or bot not ready' });
    try {
        await bot.sendMessage(parseInt(userId),
            `🎉 *VIP Mode အတည်ပြုပြီးပါပြီ!*\n\n` +
            `Admin မှ သင့် VIP Mode ကို confirm ပေးပါပြီ။\n` +
            `App ထဲမှ VIP Mode ကို On/Off ပြောင်းနိုင်ပါပြီ။ 👑✨`,
            { parse_mode: 'Markdown' }
        );
        res.json({ success: true });
    } catch (err) {
        console.error('❌ VIP confirmed notify error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==================== Referral Notification ====================
botApp.post('/referral-notify', async (req, res) => {
    const { referrerId, newUserId } = req.body;
    if (!referrerId || !newUserId) return res.status(400).json({ error: 'Missing referrerId or newUserId' });
    if (!bot || !isPolling) return res.status(503).json({ error: 'Bot not ready' });
    try {
        const message =
            `🎊 *မင်္ဂလာပါ!* 🎊\n\n` +
            `လူကြီးမင်း၏ Link မှတစ်ဆင့် လူသစ်တစ်ယောက် ([အသုံးပြုသူ ${newUserId}](tg://user?id=${newUserId})) ဝင်ရောက်လာပါသဖြင့် *၅၀ Coins* လက်ဆောင် ရရှိပါသည်။\n\n` +
            `ကျေးဇူးတင်ပါသည်။ 🙏\nNoomCoin`;
        await bot.sendMessage(parseInt(referrerId), message, { parse_mode: 'Markdown', disable_web_page_preview: true });
        console.log(`✅ Referral notification sent to referrer ${referrerId} about new user ${newUserId}`);
        res.json({ success: true });
    } catch (err) {
        console.error('❌ Referral notification error:', err.message);
        if (err.message.includes('blocked')) return res.status(200).json({ success: false, error: 'Referrer has blocked the bot' });
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==================== Error Handler ====================
app.use((err, req, res, next) => {
    console.error('❌ Express error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
});


// ── Bot startup function (called by server.js) ──
async function startBot() {
    await initializeBot();
    await loadPersistedConfig();
    console.log('🤖 NoomCoin Bot started alongside API server');
}

module.exports = { app, startBot };
