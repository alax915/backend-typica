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
            accountStatus: userData.accountStatus
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
// 5. START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
