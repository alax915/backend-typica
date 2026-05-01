const express = require('express');
const admin = require('firebase-admin');
const bodyParser = require('body-parser');
const router = express.Router();
const cors = require('cors');
const fetch = require('node-fetch');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const app = express(); // Create 'app' first
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            "default-src": ["'self'"],
            "script-src": ["'self'", "'unsafe-inline'"],
            "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            "img-src": ["'self'", "data:", "https:", "http:"], 
            "font-src": ["'self'", "https://fonts.gstatic.com"], 
            "connect-src": ["'self'", "https://backend-typica.onrender.com", "https://identitytoolkit.googleapis.com"]
        },
    },
}));
// --- updated 2 ---
let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
        // 1. Get the raw string and trim it
        const rawData = process.env.FIREBASE_SERVICE_ACCOUNT.trim();

        // 2. Parse it into an object FIRST
        serviceAccount = JSON.parse(rawData);

        // 3. NOW fix the newlines ONLY inside the private_key field
        if (serviceAccount.private_key) {
            serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
        }

        console.log("Firebase Service Account parsed successfully.");
    } catch (error) {
        console.error("CRITICAL: JSON Parse Error. Check your Render Environment Variable.");
        console.error(error.message);
    }
} else {
    try {
        serviceAccount = require("./serviceAccountKey.json");
    } catch (e) {
        console.error("Local serviceAccountKey.json not found.");
    }
}// 🔑 CONFIGURATION
// your Web API Key 
const FIREBASE_API_KEY = "AIzaSyDKYgnT9E_WEcOaZXK1xSgZpLWC-JREp28";
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const auth = admin.auth();
app.disable('x-powered-by');
app.use(cors({
    origin: [
        'https://ale-site.netlify.app',
        'http://127.0.0.1:5500',
        'http://localhost:5500'
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'CONNECT', 'OPTIONS', 'PATCH'],
    credentials: true
}));
app.use(bodyParser.json({ limit: '10kb' }));


/**
 * Helper: Generate and Verify Unique Referral Code
 * Checks Firestore to ensure the code isn't already taken.
 */
async function generateUniqueReferralCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let isUnique = false;
    let code = '';

    while (!isUnique) {
        code = '';
        for (let i = 0; i < 6; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        const check = await db.collection('users').where('myReferralCode', '==', code).get();
        if (check.empty) isUnique = true;
    }
    return code;
}

const morgan = require('morgan');
app.use(morgan('combined')); // Logs IP, Method, Path, and Status Code

app.set('trust proxy', 1);

// 1. General Limit: 100 requests every 15 minutes for most pages
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: "Too many requests, please try again later." }
});

// 2. Strict Limit: 10 requests per hour for Login & Register (Prevents Spam)
const authLimiter = rateLimit({
    windowMs: 30 * 60 * 1000,
    max: 25,
    message: { error: "Too many attempts. Please try again in an hour." }
});

// --- APPLY LIMITERS ---
app.use(generalLimiter); // Apply 100/15min to everything
app.use('/login', authLimiter); // Override with stricter limit for login
app.use('/register', authLimiter); // Override with stricter limit for registration
app.use('/api/user/update-password', authLimiter); // Protect password resets




// --- REGISTRATION ENDPOINT ---
app.post('/register', async (req, res) => {
    console.log('🚀 Registration request received');
    const { phoneDigits, password, payPassword, inviteCode } = req.body;
    // This ensures we only use the last 9 digits (e.g., 911223344)
    const cleanDigits = phoneDigits.replace(/\D/g, '').slice(-9);
    const fullPhoneNumber = '+251' + cleanDigits;
    const email = `251${cleanDigits}@phone.auth`;

    try {
        // 1. Check if user already exists
        try {
            await auth.getUserByEmail(email);
            return res.status(400).json({ error: 'Phone number already registered' });
        } catch (e) { /* User doesn't exist, proceed */ }

        // 2. Master Account Logic
        const usersSnap = await db.collection('users').limit(1).get();
        const isFirstUser = usersSnap.empty;

        // 3. Referral Validation
        let referrerDocId = null;
        if (!isFirstUser) {
            if (!inviteCode) return res.status(400).json({ error: 'Referral code is required' });

            const refQuery = await db.collection('users')
                .where('myReferralCode', '==', inviteCode.trim())
                .limit(1)
                .get();

            if (refQuery.empty) return res.status(400).json({ error: 'Invalid referral code' });
            referrerDocId = refQuery.docs[0].id;
        }

        // 4. Create Auth User
        const userRecord = await auth.createUser({
            email: email,
            password: password,
            displayName: fullPhoneNumber
        });
        const uid = userRecord.uid;

        // 5. Generate Unique Referral Code
        const myReferralCode = await generateUniqueReferralCode();

        // 6. Firestore Data
        const userData = {
            uid: uid,
            phoneNumber: fullPhoneNumber,
            phoneDigits: phoneDigits,
            email: email,
            payPassword: payPassword || null,
            balance: 25,
            coupons: 5,
            totalSpins: 0,
            inventory: [],
            myReferralCode: myReferralCode,
            totalReferrals: 0,
            referralEarnings: 0,
            accountStatus: 'active',
            isMasterAccount: isFirstUser,
            referredBy: isFirstUser ? null : inviteCode,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        };

        await db.collection('users').doc(uid).set(userData);

        // 7. Update Referrer
        if (referrerDocId) {
            await db.collection('users').doc(referrerDocId).update({
                totalReferrals: admin.firestore.FieldValue.increment(1)
            });
            await db.collection('referrals').add({
                referrerId: referrerDocId,
                referredId: uid,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
        }

        res.status(200).json({ message: 'Success', myReferralCode, uid });

    } catch (error) {
        console.error('❌ Registration Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// --- SECURE LOGIN ROUTE ---
app.post('/login', async (req, res) => {
    const { phoneDigits, password } = req.body;
    const cleanDigits = phoneDigits.replace(/\D/g, '').slice(-9);
    const email = `251${cleanDigits}@phone.auth`;

    try {
        // 🔥 SECURE STEP: Use Google REST API to verify password
        // The Admin SDK cannot verify passwords, so we use the Identity Toolkit
        const response = await fetch(
            `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`, {
            method: 'POST',
            body: JSON.stringify({ email, password, returnSecureToken: true }),
            headers: { 'Content-Type': 'application/json' }
        }
        );

        const data = await response.json();

        if (!response.ok) {
            console.error("Firebase Auth Error Details:", data.error);
            return res.status(401).json({
                error: data.error.message, // Shows actual error like "INVALID_PASSWORD"
                details: data.error.errors
            });
        }

        console.log(`✅ Secure Login successful `);

        res.status(200).json({
            uid: data.localId,
            message: "Login successful"
        });

    } catch (error) {
        console.error("❌ Login error:", error.message);
        res.status(500).json({ error: "Internal server error during login" });
    }
});



// server.js
// --- 🏆 UNIFIED SUPER ROUTE (Combines Home, Coupons, Profile, and Details) ---
app.get('/api/user-profile/:uid', async (req, res) => {
    try {
        const uid = req.params.uid;

        // Fetch user from Firestore using Admin SDK
        const userDoc = await db.collection('users').doc(uid).get();

        if (!userDoc.exists) {
            console.log(`⚠️ Profile fetch failed: UID ${uid} not found.`);
            return res.status(404).json({ error: "User not found" });
        }

        const data = userDoc.data();

        // Standardized response including EVERY field from all 4 versions
        res.status(200).json({
            uid: uid,
            phoneNumber: data.phoneNumber || "Unknown",
            balance: data.balance || 0,
            coupons: data.coupons || 0,           // From version 3
            points: data.points || 0,             // From version 4
            totalSpins: data.totalSpins || 0,     // From version 3
            myReferralCode: data.myReferralCode || "N/A", // From version 1 & 2
            referredBy: data.referredBy || "N/A", // From version 1
            referralCount: data.referralCount || 0, // From version 4
            isMasterAccount: data.isMasterAccount || false // From version 4
        });

    } catch (error) {
        console.error("❌ Profile Route Error:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});
// --- 📰 SECURE NEWS FEED ROUTE ---
app.get('/api/news/:uid', async (req, res) => {
    try {
        const uid = req.params.uid;

        // 1. Get User's read status
        const userDoc = await db.collection('users').doc(uid).get();
        if (!userDoc.exists) return res.status(404).json({ error: "User not found" });
        const readNews = userDoc.data().readNews || [];

        // 2. Fetch News from Firestore (Admin SDK)
        const newsSnap = await db.collection('news')
            .orderBy('timestamp', 'desc')
            .limit(10)
            .get();

        const newsList = [];
        newsSnap.forEach(doc => {
            const data = doc.data();
            newsList.push({
                id: doc.id,
                ...data,
                isRead: readNews.includes(doc.id),
                // Convert Firestore Timestamp to JS Date string for frontend
                timestamp: data.timestamp ? data.timestamp.toDate() : new Date()
            });
        });

        res.json({ news: newsList, phoneNumber: userDoc.data().phoneNumber });
    } catch (error) {
        console.error("❌ News Error:", error.message);
        res.status(500).json({ error: "Failed to load news" });
    }
});

// --- ✅ MARK NEWS AS READ ROUTE ---
app.post('/api/news/read', async (req, res) => {
    const { uid, newsId } = req.body;
    try {
        await db.collection('users').doc(uid).update({
            readNews: admin.firestore.FieldValue.arrayUnion(newsId)
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: "Update failed" });
    }
});

// --- 💰 GET RECHARGE PAGE DATA ---
app.get('/api/recharge-info/:uid', async (req, res) => {
    try {
        const uid = req.params.uid;
        const userDoc = await db.collection('users').doc(uid).get();

        if (!userDoc.exists) {
            return res.status(404).json({ error: "User not found" });
        }

        const data = userDoc.data();
        res.json({
            phoneNumber: data.phoneNumber,
            balance: data.balance || 0
        });
    } catch (error) {
        res.status(500).json({ error: "Failed to load recharge data" });
    }
});

// --- 📥 CREATE PENDING RECHARGE REQUEST ---
app.post('/api/recharge/submit', async (req, res) => {
    const { uid, amount, method } = req.body;

    if (!amount || amount < 10) {
        return res.status(400).json({ error: "Invalid amount (Min 10 ETB)" });
    }

    try {
        const userDoc = await db.collection('users').doc(uid).get();
        if (!userDoc.exists) return res.status(404).json({ error: "User not found" });

        const userData = userDoc.data();
        const transactionId = `recharge_${uid}_${Date.now()}`;

        // Create the pending transaction in Firestore using Admin SDK
        const transactionData = {
            userId: uid,
            userPhone: userData.phoneNumber || 'Unknown',
            type: 'recharge',
            amount: parseFloat(amount),
            method: method,
            status: 'pending',
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            balanceBefore: userData.balance || 0,
            balanceAfter: userData.balance || 0 // Unchanged until admin approves
        };

        await db.collection('transactions').doc(transactionId).set(transactionData);

        res.json({
            success: true,
            message: `Request for ${amount} ETB submitted for approval.`
        });
    } catch (error) {
        console.error("❌ Recharge Submission Error:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// --- 📥 FINAL RECHARGE SUBMISSION (To recharge-requests collection) ---
app.post('/api/recharge/final-submit', async (req, res) => {
    const { uid, amount, method, transactionId } = req.body;

    // Validation
    if (!transactionId || transactionId.length < 8) {
        return res.status(400).json({ error: "Invalid Transaction ID or SMS content." });
    }

    try {
        // 1. Get User info to include their name/phone in the request
        const userDoc = await db.collection('users').doc(uid).get();
        if (!userDoc.exists) return res.status(404).json({ error: "User not found" });

        const userData = userDoc.data();

        // 2. Prepare the data for the 'recharge-requests' collection
        const requestData = {
            userId: uid,
            userName: userData.phoneNumber || "Unknown", // "acc id" and "user name" as requested
            amount: parseFloat(amount),
            method: method,
            transactionId: transactionId, // The ID from the input field
            status: 'pending',
            submittedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        // 3. Save to the new collection
        await db.collection('recharge-requests').add(requestData);

        res.json({ success: true, message: "Recharge request submitted successfully!" });

    } catch (error) {
        console.error("❌ Final Submit Error:", error);
        res.status(500).json({ error: "Server error during submission" });
    }
});

// --- 💸 SUBMIT WITHDRAWAL REQUEST ---
app.post('/api/withdraw/submit', async (req, res) => {
    const { uid, amount } = req.body;
    const withdrawAmount = parseFloat(amount);

    if (!withdrawAmount || withdrawAmount < 100) {
        return res.status(400).json({ error: "Minimum withdrawal is 100 ETB" });
    }

    try {
        const userRef = db.collection('users').doc(uid);
        const userDoc = await userRef.get();

        if (!userDoc.exists) return res.status(404).json({ error: "User not found" });

        const userData = userDoc.data();

        // 🔥 FIX: Force balance to be a Number
        const currentBalance = Number(userData.balance) || 0;

        console.log(`Checking balance: ${currentBalance} vs Request: ${withdrawAmount}`);

        if (currentBalance < withdrawAmount) {
            return res.status(400).json({ error: "Insufficient balance" });
        }

        // 1. Deduct balance from user profile
        // Using increment(-value) works on both strings and numbers in Firestore
        await db.runTransaction(async (t) => {
            const userDoc = await t.get(userRef);
            const currentBalance = Number(userDoc.data().balance) || 0;

            if (currentBalance < withdrawAmount) throw new Error("Insufficient balance");

            t.update(userRef, {
                balance: currentBalance - withdrawAmount
            });
        });

        // 2. Create the request in 'withdraw-requests'
        const requestData = {
            "account id": uid,
            "useracc": userData.phoneNumber || "Unknown",
            "withdraw amount": withdrawAmount,
            "date": admin.firestore.FieldValue.serverTimestamp(),
            "bankDetails": userData.bankAccount || {},
            "status": "pending"
        };

        await db.collection('withdraw-requests').add(requestData);

        res.json({
            success: true,
            newBalance: currentBalance - withdrawAmount,
            message: `Withdrawal of ${withdrawAmount} ETB submitted.`
        });

    } catch (error) {
        console.error("❌ Withdraw Error:", error);
        res.status(500).json({ error: "Server Error" });
    }
});

// --- 🏦 CONSOLIDATED: SAVE BANK & PHONE DETAILS ---
app.post('/api/bank/save', async (req, res) => {
    // Destructure all possible fields from the request body
    const { uid, bankName, accountNumber, accountHolder, phoneNumber, phoneDigits } = req.body;

    // Check for core required fields
    if (!uid || !bankName || !accountNumber || !accountHolder) {
        return res.status(400).json({ error: "Required fields are missing" });
    }

    try {
        const userRef = db.collection('users').doc(uid);

        // Prepare the update object
        const updateData = {
            // Logic from Block 1 & 2: Bank Object
            bankAccount: {
                bankName: bankName,
                accountNumber: accountNumber,
                accountHolder: accountHolder,
                isVerified: false,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }
        };

        // Logic from Block 2: Only add phone details if they are provided in the request
        if (phoneNumber) updateData.phoneNumber = phoneNumber;
        if (phoneDigits) updateData.phoneDigits = phoneDigits;

        await userRef.update(updateData);

        res.json({ success: true, message: "Account details saved successfully!" });
    } catch (error) {
        console.error("❌ Bank Save Error:", error);
        res.status(500).json({ error: "Failed to save details" });
    }
});

// --- 🏦 GET WITHDRAWAL & BANK INFO ---
app.get('/api/withdraw-info/:uid', async (req, res) => {
    try {
        const uid = req.params.uid;
        const userDoc = await db.collection('users').doc(uid).get();

        if (!userDoc.exists) {
            return res.status(404).json({ error: "User not found" });
        }

        const data = userDoc.data();

        // This returns everything needed for both bank and withdraw pages
        res.json({
            phoneNumber: data.phoneNumber,
            balance: data.balance || 0,
            bankAccount: data.bankAccount || null // Includes bankName, acc number, and isVerified
        });
    } catch (error) {
        console.error("❌ Withdraw Info Error:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});




// --- 🎁 SECURE GIFT SENDING ROUTE ---
app.post('/api/gift/send', async (req, res) => {
    const { senderUid, recipientPhone, amount, bonus, message } = req.body;
    const totalDeduction = parseFloat(amount) + parseFloat(bonus);

    try {
        const senderRef = db.collection('users').doc(senderUid);
        const senderDoc = await senderRef.get();

        if (!senderDoc.exists) return res.status(404).json({ error: "Sender not found" });

        const senderData = senderDoc.data();
        const currentBalance = Number(senderData.balance) || 0;

        if (currentBalance < totalDeduction) {
            return res.status(400).json({ error: "Insufficient balance" });
        }

        // Find recipient by phone
        const formattedPhone = '+251' + recipientPhone.replace(/\D/g, '');
        const recipientQuery = await db.collection('users').where('phoneNumber', '==', formattedPhone).limit(1).get();

        if (recipientQuery.empty) {
            return res.status(404).json({ error: "Recipient not registered" });
        }

        const recipientDoc = recipientQuery.docs[0];
        const recipientRef = db.collection('users').doc(recipientDoc.id);

        // Execute Transaction (Atomic)
        await db.runTransaction(async (t) => {
            t.update(senderRef, { balance: admin.firestore.FieldValue.increment(-totalDeduction) });
            t.update(recipientRef, { balance: admin.firestore.FieldValue.increment(parseFloat(amount)) });

            const giftRecord = db.collection('gifts').doc();
            t.set(giftRecord, {
                senderId: senderUid,
                recipientId: recipientDoc.id,
                amount: parseFloat(amount),
                bonus: parseFloat(bonus),
                message: message,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                status: 'completed'
            });
        });

        res.json({ success: true, newBalance: currentBalance - totalDeduction });

    } catch (error) {
        console.error("❌ Gift Error:", error);
        res.status(500).json({ error: "Transaction failed" });
    }
});

// --- ADD THESE TO YOUR server.js ---

// 2. The Spin Engine (Subtracts coupon and picks prize)
app.post('/api/lucky-draw/spin', async (req, res) => {
    const { uid } = req.body;
    const userRef = db.collection('users').doc(uid);

    try {
        await db.runTransaction(async (t) => {
            const userDoc = await t.get(userRef);
            const userData = userDoc.data();

            if (userData.coupons < 1) throw new Error("No coupons left");

            // Logic: Pick prize based on totalSpins (Your Rarity Logic)
            const totalSpins = userData.totalSpins || 0;
            let tier = 'common';
            if (totalSpins >= 15) tier = 'legendary';
            else if (totalSpins >= 10) tier = 'epic';
            else if (totalSpins >= 5) tier = 'rare';

            // Simplified selection for server (You can expand this)
            const prize = { name: "10 ETB", value: 10, emoji: "💰", tier: tier };

            t.update(userRef, {
                coupons: admin.firestore.FieldValue.increment(-1),
                totalSpins: admin.firestore.FieldValue.increment(1),
                balance: admin.firestore.FieldValue.increment(prize.name.includes('ETB') ? prize.value : 0)
            });

            // Log the win
            const spinRef = db.collection('spins').doc();
            t.set(spinRef, {
                userId: uid,
                userPhone: userData.phoneNumber,
                prize: prize.name,
                tier: prize.tier,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });

            res.json({ prizeName: prize.name, emoji: prize.emoji, tier: prize.tier });
        });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// --- 🏆 RECENT WINNERS ROUTE ---
app.get('/api/recent-spins', async (req, res) => {
    try {
        const spinsSnapshot = await db.collection('spins')
            .orderBy('timestamp', 'desc')
            .limit(10)
            .get();

        const spins = [];
        spinsSnapshot.forEach(doc => {
            const data = doc.data();
            spins.push({
                userPhone: data.userPhone ? data.userPhone.replace(/(\d{3})\d+(\d{2})/, "$1****$2") : "Anonymous",
                prize: data.prize,
                tier: data.tier || 'common'
            });
        });

        res.json(spins);
    } catch (error) {
        console.error("Error fetching spins:", error);
        res.status(500).json({ error: "Could not load winners" });
    }
});


// --- PURCHASE API ROUTE ---
app.post('/api/purchase', async (req, res) => {
    const { uid, userPhone, productId, name, price, dailyIncome, days, limit } = req.body;

    try {
        const userRef = db.collection('users').doc(uid);

        await db.runTransaction(async (t) => {
            const userDoc = await t.get(userRef);
            if (!userDoc.exists) throw new Error("User profile not found.");

            const userData = userDoc.data();

            // 1. Check Balance
            if (userData.balance < price) {
                throw new Error("Insufficient balance.");
            }

            // 2. Check Purchase Limits (Optional logic based on your array)
            const purchasedCount = (userData.purchasedProducts || [])
                .filter(p => p.productId === productId).length;

            if (purchasedCount >= limit) {
                throw new Error(`Limit reached! You can only buy ${limit} of this item.`);
            }

            // 3. Update User Balance & Profile Array
            const purchaseEntry = {
                productId,
                name,
                purchaseDate: new Date().toISOString(),
                dailyIncome,
                status: 'active'
            };

            t.update(userRef, {
                balance: admin.firestore.FieldValue.increment(-price),
                purchasedProducts: admin.firestore.FieldValue.arrayUnion(purchaseEntry)
            });

            // 4. CREATE THE MACHINE IN 'products' COLLECTION
            // This is the CRITICAL part for the Receive page to work!
            const newMachineRef = db.collection('products').doc(); // Auto-generate ID
            t.set(newMachineRef, {
                uid: uid,
                userPhone: userPhone,           // Used for frontend filtering
                name: name,                     // Product title
                dailyIncome: Number(dailyIncome),
                days: Number(days) || 30,       // Lifespan of the machine
                lastReceive: "",                // Initialize as never collected
                purchaseDate: new Date().toISOString(),
                status: 'active'
            });
        });

        res.json({ success: true, message: "Purchase successful! Your machine is now active." });
    } catch (error) {
        console.error("Purchase Error:", error);
        res.status(400).json({ success: false, message: error.message });
    }
});

// Points Exchange
app.post('/api/points/exchange', async (req, res) => {
    const { uid, points } = req.body;
    try {
        const userRef = db.collection('users').doc(uid);

        await db.runTransaction(async (t) => {
            const userDoc = await t.get(userRef);
            if (!userDoc.exists) throw new Error("User not found");

            const data = userDoc.data();
            const userPoints = Number(data.points) || 0;
            const userBalance = Number(data.balance) || 0;

            if (userPoints < points) throw new Error("Insufficient points");

            // Convert points to balance (1:1 ratio)
            const updatedBalance = userBalance + points;
            const updatedPoints = userPoints - points;

            t.update(userRef, {
                balance: updatedBalance,
                points: updatedPoints
            });

            res.json({ newBalance: updatedBalance, newPoints: updatedPoints });
        });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.get('/api/team-stats/:uid', async (req, res) => {
    try {
        const userUid = req.params.uid;
        const userDoc = await db.collection('users').doc(userUid).get();

        if (!userDoc.exists) return res.status(404).send('User not found');

        const myReferralCode = userDoc.data().myReferralCode;

        // Use 'referredBy' to match your registration logic
        const teamSnapshot = await db.collection('users')
            .where('referredBy', '==', myReferralCode)
            .get();

        const referrals = [];
        teamSnapshot.forEach(doc => {
            const data = doc.data();
            referrals.push({
                phoneNumber: data.phoneNumber,
                balance: data.balance
            });
        });

        res.json({ referrals });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// --- ✅ SECURE DAILY CHECK-IN ROUTE ---
app.post('/api/daily-checkin', async (req, res) => {
    const { uid } = req.body;
    const todayStr = new Date().toDateString();
    const todayISO = new Date().toISOString();

    try {
        const userRef = db.collection('users').doc(uid);

        await db.runTransaction(async (t) => {
            const userDoc = await t.get(userRef);
            if (!userDoc.exists) throw new Error("User not found");

            const userData = userDoc.data();
            const dailyCheckins = userData.dailyCheckins || [];

            // Check if already checked in today
            const alreadyCheckedIn = dailyCheckins.some(date => new Date(date).toDateString() === todayStr);
            if (alreadyCheckedIn) throw new Error("Already checked in today!");

            // Update points and add current date to the array
            t.update(userRef, {
                points: admin.firestore.FieldValue.increment(1),
                dailyCheckins: admin.firestore.FieldValue.arrayUnion(todayISO),
                lastCheckin: todayISO
            });
        });

        res.json({ success: true, message: "Check-in successful! +1 point earned." });

    } catch (error) {
        console.error("❌ Check-in Error:", error.message);
        res.status(400).json({ error: error.message });
    }
});

// --- 👤 UNIFIED PROFILE SUMMARY ROUTE ---
app.get('/api/user/profile-summary/:uid', async (req, res) => {
    try {
        const uid = req.params.uid;
        if (!uid) return res.status(400).json({ error: "UID is required" });

        // 1. Fetch User Document
        const userDoc = await db.collection('users').doc(uid).get();
        if (!userDoc.exists) {
            console.error(`❌ User ${uid} not found in Firestore`);
            return res.status(404).json({ error: "User not found" });
        }

        const userData = userDoc.data();

        // 2. Initialize Defaults
        let earnings = { today: 0, yesterday: 0, week: 0, month: 0 };
        let totals = { revenue: 0, withdrawal: 0, recentRecharge: 0 };

        // 3. Date Calculations
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const startOfYesterday = new Date(startOfToday);
        startOfYesterday.setDate(startOfYesterday.getDate() - 1);

        const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

        // 4. Safe Transaction Processing
        try {
            // Simplified query to avoid index issues while debugging
            const transSnap = await db.collection('transactions').where('userId', '==', uid).get();
            if (!transSnap.empty) {
                transSnap.forEach(doc => {
                    const t = doc.data();
                    const amt = Number(t.amount) || 0;
                    if (t.type === 'recharge') {
                        totals.revenue += amt;
                        totals.recentRecharge = amt;
                    } else if (t.type === 'withdraw') {
                        totals.withdrawal += amt;
                    }
                });
            }
        } catch (e) {
            console.error("⚠️ Firestore Query failed. Ensure indexes are created on Render/Firebase console:", e.message);
            // We do NOT re-throw the error so the profile still loads even if transactions fail
        }
            }
        } catch (e) {
            console.log("⚠️ Transactions skip:", e.message);
        }

        // 5. EARNINGS LOGIC (Merged Version)

        // A. Product Income (Calculated based on active status)
        if (userData.purchasedProducts && Array.isArray(userData.purchasedProducts)) {
            userData.purchasedProducts.forEach(prod => {
                if (prod.status === 'active') {
                    const income = Number(prod.dailyIncome) || 0;
                    const pDate = new Date(prod.purchaseDate);

                    if (pDate <= startOfToday) earnings.today += income;
                    if (pDate <= startOfYesterday) earnings.yesterday += income;

                    const daysOwnedWeek = Math.min(7, Math.max(0, Math.floor((now - pDate) / 86400000) + 1));
                    earnings.week += (income * daysOwnedWeek);

                    const daysThisMonth = Math.max(0, Math.floor((now - Math.max(pDate, startOfMonth)) / 86400000) + 1);
                    earnings.month += (income * daysThisMonth);
                }
            });
        }

        // B. Check-in Bonuses (1 ETB per check-in)
        if (userData.dailyCheckins && Array.isArray(userData.dailyCheckins)) {
            userData.dailyCheckins.forEach(dateStr => {
                const d = new Date(dateStr);
                const bonus = 1;

                if (d >= startOfToday) {
                    earnings.today += bonus;
                } else if (d >= startOfYesterday && d < startOfToday) {
                    earnings.yesterday += bonus;
                }

                if (d >= sevenDaysAgo) earnings.week += bonus;
                if (d >= startOfMonth) earnings.month += bonus;
            });
        }

        // 6. Final Clean Response
        res.json({
            // Included real phone (from version 2) and masked phone (from version 1)
            phoneNumber: userData.phoneNumber || userData.phone || "---",
            maskedPhone: (userData.phoneNumber || "---").replace(/(\+\d{3})(\d{3})\d+(\d{2})/, "$1$2****$3"),

            balance: Number(userData.balance) || 0,
            recentRecharge: Number(totals.recentRecharge) || 0,
            totalRevenue: Number(totals.revenue) || 0,
            totalWithdrawal: Number(totals.withdrawal) || 0,
            referralEarnings: Number(userData.referralEarnings) || 0,
            points: Number(userData.points) || 0,
            earnings: {
                today: Number(earnings.today.toFixed(2)),
                yesterday: Number(earnings.yesterday.toFixed(2)),
                week: Number(earnings.week.toFixed(2)),
                month: Number(earnings.month.toFixed(2))
            }
        });

    } catch (error) {
        console.error("🔥 SERVER CRASH ERROR:", error.stack);
        if (!res.headersSent) {
            res.status(500).json({ error: "Internal Server Error", details: error.message });
        }
    }
});
// --- 📦 NEW: FETCH USER PRODUCTS ---
app.get('/api/user/my-products/:phone', async (req, res) => {
    const phone = req.params.phone;

    // Safety check to prevent the 'undefined' error
    if (!phone || phone === 'undefined' || phone === 'null') {
        return res.status(400).json({ error: "Valid phone number is required" });
    }

    try {
        const snapshot = await db.collection('products')
            .where('userPhone', '==', phone)
            .get();

        if (snapshot.empty) {
            return res.json([]); // Return empty list if they own nothing
        }

        let products = [];
        snapshot.forEach(doc => {
            products.push({ id: doc.id, ...doc.data() });
        });

        res.json(products);
    } catch (error) {
        console.error("❌ Product Fetch Error:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// --- ☕ NEW: RECEIVE PROFIT LOGIC ---
app.post('/api/user/receive-profit', async (req, res) => {
    const { uid, productId } = req.body;
    const today = new Date().toDateString(); // Format: "Thu Apr 02 2026"

    try {
        const userRef = db.collection('users').doc(uid);
        const productRef = db.collection('products').doc(productId);

        await db.runTransaction(async (t) => {
            const userDoc = await t.get(userRef);
            const prodDoc = await t.get(productRef);

            if (!prodDoc.exists) throw new Error("Product not found");

            const p = prodDoc.data();
            const u = userDoc.data();

            // 1. Validation
            if (p.days <= 0) throw new Error("This machine has expired");
            if (p.lastReceive === today) throw new Error("Already collected today");

            const dailyVal = Number(p.dailyIncome) || 0;

            // 2. Update Product (Reduce days, mark today as collected)
            t.update(productRef, {
                days: admin.firestore.FieldValue.increment(-1),
                lastReceive: today
            });

            // 3. Update User Balance
            t.update(userRef, {
                balance: admin.firestore.FieldValue.increment(dailyVal)
            });
        });

        res.json({ success: true, message: "Profit added to your wallet!" });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});



// GET WITHDRAWALS - Merged & Stable Version
app.get('/api/user/withdrawals/:uid', async (req, res) => {
    const { uid } = req.params;
    console.log(`\n--- 🔎 Incoming Request: Withdrawals for UID: ${uid} ---`);

    try {
        if (!uid) {
            return res.status(400).json({ success: false, message: "UID is required" });
        }

        const transactionsRef = db.collection('transactions');
        const snapshot = await transactionsRef
            .where('userId', '==', uid)
            .where('type', '==', 'withdraw')
            .orderBy('timestamp', 'desc')
            .get();

        console.log(`📊 Result: Found ${snapshot.size} withdrawal records in Firestore`);

        if (snapshot.empty) {
            console.log('ℹ️ No withdrawals found for this user.');
            return res.json({ success: true, transactions: [] });
        }

        const transactions = [];
        snapshot.forEach(doc => {
            const data = doc.data();

            // Safety check for timestamp conversion
            const timestamp = data.timestamp?.toDate ? data.timestamp.toDate() : data.timestamp;

            transactions.push({
                id: doc.id,
                ...data,
                timestamp // Overwrites the raw Firestore timestamp with a JS Date object
            });
        });

        res.json({ success: true, transactions });
        console.log('✅ Withdrawal data sent to client successfully');

    } catch (error) {
        console.error('❌ Firestore Error:', error.stack || error.message);

        // Prevent crashing if headers were already sent by accident
        if (!res.headersSent) {
            res.status(500).json({
                success: false,
                message: "Internal server error",
                details: error.message
            });
        }
    }
});
// --- CONTRACT ENDPOINTS ---

/**
 * GET /api/contract/:uid
 * Securely retrieves a user's contract data from Firestore
 */
app.get('/api/contract/:uid', async (req, res) => {
    const uid = req.params.uid;

    if (!uid) {
        return res.status(400).json({ error: 'UID is required' });
    }

    try {
        // Use admin.firestore() to bypass client-side rules
        const contractDoc = await db.collection('contracts').doc(uid).get();

        if (!contractDoc.exists) {
            return res.status(404).json({ message: 'No contract found for this user' });
        }

        res.status(200).json(contractDoc.data());
    } catch (error) {
        console.error('Error fetching contract:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * POST /api/contract/sign
 * Receives the signature and contract data to save securely
 */
app.post('/api/contract/sign', async (req, res) => {
    const { uid, signatureImage, contractText } = req.body;

    // Validation
    if (!uid || !signatureImage) {
        return res.status(400).json({ error: 'Missing UID or Signature data' });
    }

    try {
        const contractData = {
            uid: uid,
            signatureImage: signatureImage, // This is the Base64 string from the canvas
            contractText: contractText,
            signed: true,
            signedAt: new Date().toISOString(),
            status: 'active'
        };

        // Save to the 'contracts' collection
        await db.collection('contracts').doc(uid).set(contractData, { merge: true });

        // Optional: Update the user document to reflect they have signed
        await db.collection('users').doc(uid).update({
            hasSignedContract: true
        });

        res.status(200).json({ message: 'Contract signed and saved successfully' });
    } catch (error) {
        console.error('Error saving contract:', error);
        res.status(500).json({ error: 'Failed to save contract' });
    }
});



// --- 🔐 SECURE: UPDATE LOGIN PASSWORD ---
app.post('/api/user/update-password', async (req, res) => {
    const { uid, newPassword } = req.body;

    // 1. Validation check
    if (!uid || !newPassword || newPassword.length < 6) {
        return res.status(400).json({ error: "Invalid password (min 6 characters)" });
    }

    try {
        // 2. Update the password in Firebase Auth only
        // Firebase Auth handles encryption and security automatically.
        await auth.updateUser(uid, {
            password: newPassword
        });

        // 3. Removed the Firestore update for the password field.
        // We do NOT store plaintext passwords in the database for security reasons.

        console.log(`✅ Password updated securely in Auth for user: ${uid}`);
        res.json({ success: true, message: "Password updated successfully" });

    } catch (error) {
        console.error("❌ Password Update Error:", error);
        res.status(500).json({ error: "Failed to update password" });
    }
});

// --- 📍 SECURE: SAVE USER ADDRESS ---
app.post('/api/user/save-address', async (req, res) => {
    const { uid, addressData } = req.body;

    if (!uid || !addressData.name || !addressData.address) {
        return res.status(400).json({ error: "Missing required address fields" });
    }

    try {
        const userRef = db.collection('users').doc(uid);

        await userRef.update({
            address: {
                name: addressData.name,
                phone: addressData.phone,
                address: addressData.address,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }
        });

        console.log(`✅ Address updated for user: ${uid}`);
        res.json({ success: true, message: "Address saved successfully" });
    } catch (error) {
        console.error("❌ Address Save Error:", error);
        res.status(500).json({ error: "Failed to save address" });
    }
});


// --- 💰 FIXED: CHANGE PAY PASSWORD ---
app.post('/api/user/change-pay-password', async (req, res) => {
    const { uid, oldPayPassword, newPayPassword } = req.body;

    try {
        const userRef = db.collection('users').doc(uid);
        const userDoc = await userRef.get();

        if (!userDoc.exists) return res.status(404).json({ error: "User not found" });

        const userData = userDoc.data();

        // DEBUG LOGS
        console.log(`Checking Pay Pwd for UID: ${uid}`);
        console.log(`Input: [${oldPayPassword}] | Stored: [${userData.payPassword}]`);

        if (!userData.payPassword || userData.payPassword.trim() !== oldPayPassword.trim()) {
            return res.status(401).json({ error: "Old pay password incorrect in database" });
        }

        await userRef.update({ payPassword: newPayPassword });
        res.json({ success: true });
    } catch (error) {
        console.error("Pay Pwd Error:", error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is live on port ${PORT}`);
});
