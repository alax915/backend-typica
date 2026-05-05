const express = require('express');
const app = express();
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const dotenv = require('dotenv');
const admin = require('firebase-admin');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
// 1. CONFIGURATION
dotenv.config();

// 2. FIREBASE ADMIN INITIALIZATION
try {
  // Instead of requiring a local file, we parse the JSON string from Environment Variables
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log("✅ Firebase Admin Initialized");
} catch (error) {
  console.error("❌ Firebase Initialization Error:", error.message);
}

const db = admin.firestore();

// 3. MIDDLEWARE
app.use(cors({
  origin: [
    'http://localhost:5500', 
    'http://127.0.0.1:5500', 
    'http://192.168.1.101:5500',
    process.env.FRONTEND_URL // Add your live website URL here later via Render dashboard
  ].filter(Boolean) // Removes undefined values if FRONTEND_URL isn't set yet
}));
app.use(helmet());
app.use(morgan('dev'));
app.use(express.json());

// 4. ROUTES

// Registration Endpoint
app.post('/api/register', async (req, res) => {
    try {
        const { phoneDigits, password, inviteCode, payPassword } = req.body;

        if (!phoneDigits || !password) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        const email = `251${phoneDigits}@phone.auth`;
        const fullPhoneNumber = `+251${phoneDigits}`;

        const usersRef = db.collection('users');
        const snapshot = await usersRef.count().get();
        const isFirstUser = snapshot.data().count === 0;

        let referrerDocId = null;
        if (!isFirstUser) {
            if (!inviteCode) {
                return res.status(400).json({ error: "Referral code is required" });
            }
            const referrerQuery = await usersRef.where('myReferralCode', '==', inviteCode).get();
            if (referrerQuery.empty) {
                return res.status(400).json({ error: "Invalid referral code" });
            }
            referrerDocId = referrerQuery.docs[0].id;
        }

        const userRecord = await admin.auth().createUser({
            email: email,
            password: password,
            displayName: phoneDigits
        });

        const myReferralCode = Math.random().toString(36).substring(2, 8).toUpperCase();

        const userData = {
            uid: userRecord.uid,
            phoneNumber: fullPhoneNumber,
            phoneDigits: phoneDigits,
            email: email,
            payPassword: payPassword || null,
            balance: 25, // Initial signup bonus
            coupons: 5,
            readNews: [], // CRITICAL: Initializes empty list for news tracking[cite: 5]
            myReferralCode: myReferralCode,
            isMasterAccount: isFirstUser,
            accountType: isFirstUser ? 'master' : 'regular',
            referredBy: isFirstUser ? null : inviteCode,
            totalReferrals: 0,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            accountStatus: 'active'
        };

        await usersRef.doc(userRecord.uid).set(userData);

        if (referrerDocId) {
            await usersRef.doc(referrerDocId).update({
                totalReferrals: admin.firestore.FieldValue.increment(1)
            });
        }

        res.status(201).json({ 
            success: true, 
            message: "Registration successful", 
            uid: userRecord.uid 
        });

    } catch (error) {
        console.error("Registration Error:", error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/', (req, res) => {
  res.send('Backend Server is Running');
});

// --- UPDATED LOGIN ROUTE ---
app.post('/api/login', async (req, res) => {
    try {
        const { phoneDigits, password } = req.body;
        const email = `251${phoneDigits}@phone.auth`;

        // 1. VERIFY PASSWORD via Firebase REST API
        // You need your "Web API Key" from Firebase Project Settings -> General
        const FIREBASE_API_KEY = process.env.FIREBASE_CLIENT_API_KEY; 
        
        const signInResponse = await fetch(
            `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
            {
                method: 'POST',
                body: JSON.stringify({ 
                    email: email, 
                    password: password, 
                    returnSecureToken: true 
                }),
                headers: { 'Content-Type': 'application/json' }
            }
        );

        const signInData = await signInResponse.json();

        // If Firebase says the password or email is wrong
        if (signInData.error) {
            console.log("❌ Authentication failed:", signInData.error.message);
            return res.status(401).json({ error: "Invalid phone number or password." });
        }

        const uid = signInData.localId;

        // 2. DATABASE CHECK: Verify account status in Firestore
        const userDoc = await db.collection('users').doc(uid).get();

        if (!userDoc.exists) {
            return res.status(404).json({ error: "User profile not found in database." });
        }

        const userData = userDoc.data();

        // Check if account is disabled
        if (userData.accountStatus === 'disabled') {
            return res.status(403).json({ error: "Account disabled. Please contact support." });
        }

        // 3. SUCCESS: Password is correct and account is active
        res.status(200).json({
            success: true,
            uid: uid,
            message: "Login successful"
        });

    } catch (error) {
        console.error("Login Error:", error);
        res.status(500).json({ error: "Internal server error during login." });
    }
});

// GET USER PROFILE DATA
app.get('/api/user/:uid', async (req, res) => {
    try {
        const { uid } = req.params;
        
        // Fetch user from Firestore
        const userDoc = await db.collection('users').doc(uid).get();

        if (!userDoc.exists) {
            return res.status(404).json({ error: "User not found" });
        }

        const userData = userDoc.data();

        // Return only the necessary info to the home page
        res.status(200).json({
            phoneNumber: userData.phoneNumber,
            balance: userData.balance,
            myReferralCode: userData.myReferralCode,
            totalReferrals: userData.totalReferrals,
            accountStatus: userData.accountStatus,
            accountLevel: userData.accountLevel,
            accountStatus: userData.accountStatus,
            accountType: userData.accountType,
            bankAccount: userData.bankAccount,
            checkinHistory: userData.checkinHistory,
            coupons: userData.coupons,
            createdAt: userData.createdAt,
            dailyCheckins: userData.dailyCheckins,
            hasSignedContract: userData.hasSignedContract,
            inviteCode: userData.inviteCode,
            isMasterAccount: userData.isMasterAccount,
            payPassword: userData.payPassword,
            uid: userData.uid
        });

    } catch (error) {
        console.error("Error fetching profile:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

//News Fetching Route
app.get('/api/news', async (req, res) => {
    try {
        const newsSnapshot = await db.collection('news')
            .orderBy('timestamp', 'desc')
            .limit(10)
            .get();

        const news = [];
        newsSnapshot.forEach(doc => {
            news.push({ 
                id: doc.id, 
                ...doc.data(),
                // Convert Firestore timestamp to a format JS understands
                timestamp: doc.data().timestamp ? doc.data().timestamp.toDate() : new Date() 
            });
        });

        res.status(200).json(news);
    } catch (error) {
        console.error("Error fetching news:", error);
        res.status(500).json({ error: "Failed to fetch news" });
    }
});

// Recharge Request Endpoint
app.post('/api/recharge/request', async (req, res) => {
    try {
        const { uid, amount, method, phoneNumber } = req.body;

        if (!uid || !amount || !method) {
            return res.status(400).json({ error: "Missing transaction details" });
        }

        const transactionId = `recharge_${uid}_${Date.now()}`;
        const transactionRef = db.collection('recharge-requests').doc(transactionId);

        const transactionData = {
            userId: uid,
            userPhone: phoneNumber || 'Unknown',
            type: 'recharge',
            amount: parseFloat(amount),
            method: method,
            status: 'pending', // Requires admin approval to update balance[cite: 6]
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            transactionId: transactionId
        };

        await transactionRef.set(transactionData);

        console.log(`✅ Recharge request created: ${transactionId}`);
        
        res.status(200).json({ 
            success: true, 
            message: "Recharge request submitted. Pending admin approval.",
            transactionId: transactionId
        });

    } catch (error) {
        console.error("Recharge Error:", error);
        res.status(500).json({ error: "Internal server error processing recharge" });
    }
});

// --- NEW WITHDRAWAL REQUEST ENDPOINT ---
app.post('/api/withdraw/request', async (req, res) => {
    try {
        const { uid, amount, fee, netAmount, phoneNumber, bankAccount } = req.body;

        if (!uid || !amount) {
            return res.status(400).json({ error: "Missing withdrawal details" });
        }

        const userRef = db.collection('users').doc(uid);
        
        // Use a transaction for security: Deduct balance and create request together
        await db.runTransaction(async (t) => {
            const userDoc = await t.get(userRef);
            if (!userDoc.exists) throw new Error("User profile not found");
            
            const currentBalance = userDoc.data().balance || 0;
            if (amount > currentBalance) throw new Error("Insufficient balance");

            // 1. Deduct balance immediately from the user account
            t.update(userRef, {
                balance: currentBalance - amount,
                lastWithdrawAt: admin.firestore.FieldValue.serverTimestamp(),
                totalWithdrawals: admin.firestore.FieldValue.increment(1)
            });

            // 2. Create the pending transaction record for admin review
            const transactionId = `withdraw_${uid}_${Date.now()}`;
            const transRef = db.collection('withdraw-requests').doc(transactionId);
            
            t.set(transRef, {
                userId: uid,
                userPhone: phoneNumber,
                type: 'withdraw',
                amount: parseFloat(amount),
                fee: parseFloat(fee),
                netAmount: parseFloat(netAmount),
                status: 'pending', // Set as pending for admin approval[cite: 6]
                bankAccount: bankAccount || {},
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                transactionId: transactionId
            });
        });

        res.status(200).json({ success: true, message: "Withdrawal submitted and pending" });

    } catch (error) {
        console.error("Withdraw Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- CASH GIFT ENDPOINT ---
app.post('/api/gift/send', async (req, res) => {
    try {
        const { senderUid, recipientPhone, amount, bonus, message } = req.body;
        const totalDeduction = parseFloat(amount) + parseFloat(bonus);

        if (!senderUid || !recipientPhone || !amount) {
            return res.status(400).json({ error: "Missing gift details" });
        }

        const senderRef = db.collection('users').doc(senderUid);
        
        // Find recipient by phone number
        const formattedPhone = `+251${recipientPhone.replace(/\D/g, '')}`;
        const recipientQuery = await db.collection('users').where('phoneNumber', '==', formattedPhone).get();

        if (recipientQuery.empty) {
            return res.status(404).json({ error: "Recipient not found. Check the phone number." });
        }

        const recipientDoc = recipientQuery.docs[0];
        const recipientRef = db.collection('users').doc(recipientDoc.id);

        // Run transaction to swap funds securely
        await db.runTransaction(async (t) => {
            const senderDoc = await t.get(senderRef);
            if (!senderDoc.exists) throw new Error("Sender not found");

            const senderBalance = senderDoc.data().balance || 0;
            if (senderBalance < totalDeduction) throw new Error("Insufficient balance");

            const recipientBalance = recipientDoc.data().balance || 0;

            // 1. Deduct from sender
            t.update(senderRef, { 
                balance: senderBalance - totalDeduction 
            });

            // 2. Add to recipient
            t.update(recipientRef, { 
                balance: recipientBalance + parseFloat(amount) 
            });

            // 3. Log the gift record
            const giftRef = db.collection('gifts').doc();
            t.set(giftRef, {
                senderId: senderUid,
                recipientId: recipientDoc.id,
                amount: parseFloat(amount),
                bonus: parseFloat(bonus),
                total: totalDeduction,
                message: message || "",
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                status: 'completed'
            });
        });

        res.status(200).json({ success: true, message: "Gift sent successfully!" });

    } catch (error) {
        console.error("Gift Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// --- LUCKY DRAW SPIN ENDPOINT ---
app.post('/api/lucky-draw/spin', async (req, res) => {
    try {
        const { uid } = req.body;
        if (!uid) return res.status(400).json({ error: "User ID required" });

        const userRef = db.collection('users').doc(uid);

        const result = await db.runTransaction(async (t) => {
            const userDoc = await t.get(userRef);
            if (!userDoc.exists) throw new Error("User not found");

            const data = userDoc.data();
            const currentCoupons = data.coupons || 0;
            const currentBalance = data.balance || 0;
            const totalSpins = data.totalSpins || 0;

            if (currentCoupons < 1) throw new Error("Insufficient coupons");

            // Define Prizes (Keep identical to frontend for visual alignment)
            const prizePool = [
                { name: '10 ETB', value: 10, tier: 'common', prob: 0.4 },
                { name: '20 ETB', value: 20, tier: 'common', prob: 0.3 },
                { name: '50 ETB', value: 50, tier: 'common', prob: 0.2 },
                { name: 'Power Bank', value: 'Power Bank', tier: 'rare', prob: 0.05 },
                { name: 'Smart Watch', value: 'Smart Watch', tier: 'epic', prob: 0.04 },
                { name: 'Smartphone', value: 'Smartphone', tier: 'legendary', prob: 0.01 }
            ];

            // Select Prize
            let random = Math.random();
            let cumulative = 0;
            let selectedPrize = prizePool[0];

            for (const p of prizePool) {
                cumulative += p.prob;
                if (random < cumulative) {
                    selectedPrize = p;
                    break;
                }
            }

            // Update User Data
            const updates = {
                coupons: currentCoupons - 1,
                totalSpins: totalSpins + 1,
                lastSpinAt: admin.firestore.FieldValue.serverTimestamp()
            };

            if (selectedPrize.name.includes('ETB')) {
                updates.balance = currentBalance + selectedPrize.value;
            } else {
                const inventory = data.inventory || [];
                inventory.push({
                    name: selectedPrize.name,
                    tier: selectedPrize.tier,
                    wonAt: new Date().toISOString(),
                    claimed: false
                });
                updates.inventory = inventory;
            }

            t.update(userRef, updates);

            // Log spin history
            const spinRef = db.collection('spins').doc();
            t.set(spinRef, {
                userId: uid,
                userPhone: data.phoneNumber || 'Unknown',
                prize: selectedPrize.name,
                prizeTier: selectedPrize.tier,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });

            return { selectedPrize, newCoupons: updates.coupons, newSpins: updates.totalSpins };
        });

        res.status(200).json({ success: true, ...result });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /api/purchase-product
app.post('/api/purchase-product', async (req, res) => {
    const { userId, productId } = req.body;

    if (!userId || !productId) {
        return res.status(400).json({ success: false, message: "Missing data" });
    }

    // Product Data (Source of Truth)
    const PRODUCTS_SOT = {
        'samsung-phone': { price: 7000, title: 'Galaxy S23 Ultra', limit: 5 },
        'mac-book-pro': { price: 12000, title: 'Mac-Book-Pro', limit: 7 },
        'smart-watch': { price: 2000, title: 'Smart-Watch', limit: 2 },
        'head-phone': { price: 1200, title: 'Head-Phone', limit: 1 },
        'tablet': { price: 4000, title: 'Tablet', limit: 3 },
        'gaming-console': { price: 24000, title: 'Gaming-Console', limit: 15 }
    };

    const product = PRODUCTS_SOT[productId];
    if (!product) return res.status(404).json({ success: false, message: "Product not found" });

    try {
        const userRef = db.collection('users').doc(userId);
        
        const result = await db.runTransaction(async (t) => {
            const userDoc = await t.get(userRef);
            if (!userDoc.exists) throw "User not found";

            const userData = userDoc.data();
            const currentBalance = userData.balance || 0;
            const inventory = userData.inventory || [];
            
            // Check Purchase Limit
            const purchaseCount = inventory.filter(item => item.id === productId).length;
            if (purchaseCount >= product.limit) {
                throw `Purchase limit reached for ${product.title}`;
            }

            // Check Balance
            if (currentBalance < product.price) {
                throw "Insufficient balance";
            }

            // Perform Transaction
            const newBalance = currentBalance - product.price;
            const newItem = {
                id: productId,
                title: product.title,
                purchasedAt: new Date().toISOString()
            };

            t.update(userRef, {
                balance: newBalance,
                inventory: admin.firestore.FieldValue.arrayUnion(newItem)
            });

            return { newBalance };
        });

        res.json({ success: true, balance: result.newBalance });
    } catch (error) {
        res.status(400).json({ success: false, message: error });
    }
});
// 5. START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
