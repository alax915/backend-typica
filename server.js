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
            points: userData.points || 0,
            myReferralCode: userData.myReferralCode,
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
// ==========================================
// 4.6. UPDATE BANK DETAILS ROUTE
// ==========================================
app.post('/api/user/update-bank', async (req, res) => {
    try {
        const { uid, bankAccount } = req.body;

        // Validation
        if (!uid) {
            return res.status(400).json({ error: "Missing user UID." });
        }
        if (!bankAccount || !bankAccount.bankName || !bankAccount.accountNumber || !bankAccount.accountHolder) {
            return res.status(400).json({ error: "Missing required bank details." });
        }

        const userRef = db.collection('users').doc(uid);
        const userDoc = await userRef.get();

        if (!userDoc.exists) {
            return res.status(404).json({ error: "User profile not found." });
        }

        // Update nested bank account information securely on the server
        await userRef.update({
            bankAccount: {
                bankName: bankAccount.bankName,
                accountNumber: bankAccount.accountNumber,
                accountHolder: bankAccount.accountHolder,
                isVerified: false, // Security check: resetting verification status on edit
                updatedAt: new Date().toISOString()
            }
        });

        console.log(`🏦 Bank details updated successfully for UID: ${uid}`);
        return res.status(200).json({ 
            success: true, 
            message: "Bank details saved successfully. Verification is pending." 
        });

    } catch (error) {
        console.error("❌ Error updating bank details on server:", error);
        return res.status(500).json({ error: "Internal server error. Failed to save bank details." });
    }
});
// --- NEW ROUTE: RECHARGE REQUEST ---
app.post('/api/recharge/request', async (req, res) => {
    try {
        const { uid, amount, method, phoneNumber } = req.body;

        if (!uid || !amount || !method) {
            return res.status(400).json({ error: "Missing required recharge data" });
        }

        // Create a pending recharge document for admin approval
        const rechargeRef = db.collection('recharges').doc();
        await rechargeRef.set({
            uid: uid,
            amount: parseFloat(amount),
            method: method,
            phoneNumber: phoneNumber || "Unknown",
            status: 'pending', // Requires manual admin approval to update balance
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        res.status(200).json({ 
            success: true, 
            message: "Recharge request submitted for approval" 
        });
    } catch (error) {
        console.error("Recharge Route Error:", error);
        res.status(500).json({ error: "Failed to submit recharge request" });
    }
});
// --- NEW ROUTE: WITHDRAWAL REQUEST ---
app.post('/api/withdraw/request', async (req, res) => {
    try {
        const { uid, amount, fee, netAmount, phoneNumber, bankAccount } = req.body;

        if (!uid || !amount) {
            return res.status(400).json({ error: "Missing required withdrawal data" });
        }

        const userRef = db.collection('users').doc(uid);

        // Transaction ensures data consistency
        await db.runTransaction(async (t) => {
            const userDoc = await t.get(userRef);
            if (!userDoc.exists) throw "User not found";

            const currentBalance = userDoc.data().balance || 0;
            if (currentBalance < amount) {
                throw "Insufficient balance for this withdrawal";
            }

            // 1. Deduct balance from user
            t.update(userRef, {
                balance: admin.firestore.FieldValue.increment(-amount)
            });

            // 2. Create withdrawal record for admin approval
            const withdrawRef = db.collection('withdrawals').doc();
            t.set(withdrawRef, {
                uid,
                amount,
                fee,
                netAmount,
                phoneNumber,
                bankAccount,
                status: 'pending',
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
        });

        res.status(200).json({ success: true, message: "Withdrawal submitted" });
    } catch (error) {
        console.error("Withdrawal Error:", error);
        res.status(400).json({ error: typeof error === 'string' ? error : "Transaction failed" });
    }
});
// --- NEW ROUTE: SEND CASH GIFT (P2P TRANSFER) ---
app.post('/api/gift/send', async (req, res) => {
    const { senderUid, recipientPhone, amount, bonus, message } = req.body;

    if (!senderUid || !recipientPhone || !amount) {
        return res.status(400).json({ error: "Missing transfer details" });
    }

    try {
        const totalDeduction = parseFloat(amount) + (parseFloat(bonus) || 0);
        const senderRef = db.collection('users').doc(senderUid);
        
        // Find recipient by phone number
        const recipientQuery = await db.collection('users').where('phoneNumber', '==', recipientPhone).limit(1).get();
        
        if (recipientQuery.empty) {
            return res.status(404).json({ error: "Recipient phone number not found in system" });
        }

        const recipientDoc = recipientQuery.docs[0];
        const recipientRef = recipientDoc.ref;

        if (recipientDoc.id === senderUid) {
            return res.status(400).json({ error: "You cannot send a gift to yourself" });
        }

        await db.runTransaction(async (t) => {
            const senderDoc = await t.get(senderRef);
            if (senderDoc.data().balance < totalDeduction) {
                throw "Insufficient balance";
            }

            // 1. Deduct from sender
            t.update(senderRef, {
                balance: admin.firestore.FieldValue.increment(-totalDeduction)
            });

            // 2. Add to recipient
            t.update(recipientRef, {
                balance: admin.firestore.FieldValue.increment(parseFloat(amount))
            });

            // 3. Log the transaction
            const logRef = db.collection('transactions').doc();
            t.set(logRef, {
                type: 'gift',
                senderUid,
                senderPhone: senderDoc.data().phoneNumber,
                recipientUid: recipientDoc.id,
                recipientPhone,
                amount: parseFloat(amount),
                bonus: parseFloat(bonus) || 0,
                message: message || "",
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
        });

        res.status(200).json({ success: true, message: "Gift sent successfully" });
    } catch (error) {
        console.error("Gift Transaction Error:", error);
        res.status(400).json({ error: typeof error === 'string' ? error : "Transfer failed" });
    }
});
// --- NEW ROUTE: LUCKY DRAW SPIN ---
app.post('/api/lucky-draw/spin', async (req, res) => {
    const { uid } = req.body;
    const prizes = [
        { name: '10 ETB', weight: 60, value: 10, type: 'balance' },
        { name: '20 ETB', weight: 25, value: 20, type: 'balance' },
        { name: '50 ETB', weight: 10, value: 50, type: 'balance' },
        { name: 'Power Bank', weight: 3, type: 'physical' },
        { name: 'Smart Watch', weight: 1.5, type: 'physical' },
        { name: 'Smartphone', weight: 0.5, type: 'physical' }
    ];

    try {
        const userRef = db.collection('users').doc(uid);

        const result = await db.runTransaction(async (t) => {
            const userDoc = await t.get(userRef);
            const currentCoupons = userDoc.data().coupons || 0;

            if (currentCoupons < 1) throw "No coupons available";

            // 1. Pick a prize based on weight
            let random = Math.random() * 100;
            let cumulative = 0;
            let selectedPrize = prizes[0];

            for (const p of prizes) {
                cumulative += p.weight;
                if (random <= cumulative) {
                    selectedPrize = p;
                    break;
                }
            }

            // 2. Update user data
            let updateData = {
                coupons: admin.firestore.FieldValue.increment(-1),
                totalSpins: admin.firestore.FieldValue.increment(1)
            };

            // If cash prize, add to balance
            if (selectedPrize.type === 'balance') {
                updateData.balance = admin.firestore.FieldValue.increment(selectedPrize.value);
            }

            t.update(userRef, updateData);
            
            return {
                selectedPrize,
                newCoupons: currentCoupons - 1,
                newSpins: (userDoc.data().totalSpins || 0) + 1
            };
        });

        res.status(200).json({ success: true, ...result });
    } catch (error) {
        res.status(400).json({ success: false, error: error.toString() });
    }
});
// --- NEW ROUTE: EXCHANGE POINTS FOR BALANCE ---
app.post('/api/user/exchange-points', async (req, res) => {
    const { uid, points } = req.body;

    if (!uid || !points || points <= 0) {
        return res.status(400).json({ error: "Invalid exchange request" });
    }

    try {
        const userRef = db.collection('users').doc(uid);

        await db.runTransaction(async (t) => {
            const userDoc = await t.get(userRef);
            if (!userDoc.exists) throw "User not found";

            const currentPoints = userDoc.data().points || 0;
            if (currentPoints < points) throw "Insufficient points";

            // 1 point = 1 ETB
            const amountToAdd = parseFloat(points);

            t.update(userRef, {
                points: admin.firestore.FieldValue.increment(-points),
                balance: admin.firestore.FieldValue.increment(amountToAdd),
                lastExchangeAt: admin.firestore.FieldValue.serverTimestamp()
            });
        });

        res.status(200).json({ success: true, message: "Points exchanged successfully" });
    } catch (error) {
        console.error("Exchange Error:", error);
        res.status(400).json({ error: typeof error === 'string' ? error : "Exchange failed" });
    }
});
// --- NEW ROUTE: DAILY CHECK-IN ---
app.post('/api/user/checkin', async (req, res) => {
    const { uid } = req.body;
    const todayStr = new Date().toDateString();

    try {
        const userRef = db.collection('users').doc(uid);

        const result = await db.runTransaction(async (t) => {
            const userDoc = await t.get(userRef);
            if (!userDoc.exists) throw "User not found";

            const data = userDoc.data();
            const checkins = data.dailyCheckins || [];

            // Check if user already checked in today
            const alreadyDone = checkins.some(date => new Date(date).toDateString() === todayStr);
            if (alreadyDone) throw "Already checked in today";

            const now = new Date().toISOString();
            
            t.update(userRef, {
                points: admin.firestore.FieldValue.increment(1),
                dailyCheckins: admin.firestore.FieldValue.arrayUnion(now),
                lastCheckin: now
            });

            return { success: true };
        });

        res.status(200).json(result);
    } catch (error) {
        res.status(400).json({ success: false, error: error.toString() });
    }
});

// --- GET USER ORDERS (My Products) ---
app.get('/api/user/orders/:uid', async (req, res) => {
    const { uid } = req.params;

    try {
        // Query the 'orders' collection for docs where userId matches the UID
        const ordersSnapshot = await db.collection('orders')
            .where('userId', '==', uid)
            .get();

        if (ordersSnapshot.empty) {
            return res.status(200).json([]); // Return empty array if no orders
        }

        const orders = [];
        ordersSnapshot.forEach(doc => {
            orders.push({ id: doc.id, ...doc.data() });
        });

        // Sort by purchase date (newest first) if timestamp exists
        orders.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

        res.status(200).json(orders);
    } catch (error) {
        console.error("Error fetching orders:", error);
        res.status(500).json({ error: "Failed to load orders" });
    }
});
// 5. START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
