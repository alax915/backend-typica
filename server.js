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
    'http://192.168.1.102:5500',
    'http://192.168.1.103:5500',
    'http://192.168.1.104:5500',
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

// --- NEW ROUTE: GET USER WITHDRAWALS ---
app.get('/api/user/withdrawals/:uid', async (req, res) => {
    try {
        const { uid } = req.params;
        let snapshot = await db.collection('withdrawals').where('uid', '==', uid).get();
        if (snapshot.empty) {
            snapshot = await db.collection('withdrawals').where('userId', '==', uid).get();
        }
        const withdrawals = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        withdrawals.sort((a, b) => {
            const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
            const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
            return tb - ta;
        });
        res.json(withdrawals);
    } catch (error) {
        console.error('Withdrawals route error:', error);
        res.status(500).json({ error: error.message });
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

            // 3. Log the spin result
            const spinRef = db.collection('spins').doc();
            t.set(spinRef, {
                userId: uid,
                uid: uid, // for backward compatibility
                prize: selectedPrize.name,
                prizeValue: selectedPrize.type === 'balance' ? selectedPrize.value : 0,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });

            // 4. If cash prize, also log as transaction
            if (selectedPrize.type === 'balance') {
                const transactionRef = db.collection('transactions').doc();
                t.set(transactionRef, {
                    userId: uid,
                    type: 'spin',
                    amount: selectedPrize.value,
                    description: `Spin prize: ${selectedPrize.name}`,
                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                });
            }
            
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
// --- GET USER ORDERS (Fixed to match Phone Number logic) ---
app.get('/api/user/orders/:uid', async (req, res) => {
    const { uid } = req.params;

    try {
        // 1. First, find the user document to get their phone number
        const userDoc = await db.collection('users').doc(uid).get();
        
        if (!userDoc.exists) {
            return res.status(404).json({ error: "User not found" });
        }

        const userData = userDoc.data();
        const userPhone = userData.phoneNumber; // Get the phone number from the user doc

        // 2. Now search the 'products' collection using that phone number
        const productsSnapshot = await db.collection('products')
            .where('userPhone', '==', userPhone) 
            .get();

        if (productsSnapshot.empty) {
            return res.status(200).json([]); 
        }

        const orders = [];
        productsSnapshot.forEach(doc => {
            orders.push({ id: doc.id, ...doc.data() });
        });

        res.status(200).json(orders);
    } catch (error) {
        console.error("Error fetching orders:", error);
        res.status(500).json({ error: "Failed to load products" });
    }
});
// --- 5. RECEIVE DAILY INCOME ROUTE ---
app.post('/api/products/receive', async (req, res) => {
    const { uid, productId } = req.body;

    if (!uid || !productId) {
        return res.status(400).json({ error: "Missing required information" });
    }

    try {
        await db.runTransaction(async (transaction) => {
            const productRef = db.collection('products').doc(productId);
            const userRef = db.collection('users').doc(uid);

            const productDoc = await transaction.get(productRef);
            const userDoc = await transaction.get(userRef);

            if (!productDoc.exists) throw new Error("Product record not found");
            if (!userDoc.exists) throw new Error("User record not found");

            const product = productDoc.data();
            const userData = userDoc.data();

            // Security: Ensure product belongs to the user
            if (product.userPhone !== userData.phoneNumber) {
                throw new Error("Unauthorized: Product ownership mismatch");
            }

            // Validation: Check days remaining
            const days = parseInt(product.days || 0);
            if (days <= 0) throw new Error("This product has expired");

            // Validation: Check if already received today
            const today = new Date().toISOString().split('T')[0];
            if (product.lastReceive === today) {
                throw new Error("You have already received today's income");
            }

            const dailyIncome = parseFloat(product.dailyIncome || product.dailyProfit || 0);

            // UPDATES
            transaction.update(productRef, {
                days: days - 1,
                lastReceive: today,
                totalEarnings: (parseFloat(product.totalEarnings || 0) + dailyIncome),
                currentIncome: (parseFloat(product.currentIncome || 0) + dailyIncome)
            });

            transaction.update(userRef, {
                balance: (parseFloat(userData.balance || 0) + dailyIncome)
            });

            res.json({ 
                success: true, 
                dailyIncome: dailyIncome,
                message: "Income successfully claimed" 
            });
        });
    } catch (error) {
        console.error("Receive Error:", error.message);
        res.status(400).json({ error: error.message });
    }
});
app.get('/api/user/transactions/:uid', async (req, res) => {
    try {
        const { uid } = req.params;
        const { type } = req.query; // e.g., ?type=withdraw
        
        let query = db.collection('transactions').where('userId', '==', uid);
        
        if (type) {
            query = query.where('type', '==', type);
        }

        const snapshot = await query.orderBy('timestamp', 'desc').get();
        const transactions = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        
        res.json(transactions);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
app.post('/api/user/contract/sign', async (req, res) => {
    try {
        const { uid, signatureImage, contractText, signedAt } = req.body;
        
        // Save to your database (e.g., Firestore via Admin SDK)
        await db.collection('contracts').doc(uid).set({
            contractText,
            signatureImage,
            signed: true,
            signedAt: signedAt || new Date().toISOString()
        }, { merge: true });
        
        res.json({ success: true, message: "Contract signed successfully" });
    } catch (error) {
        console.error("Error saving signature:", error);
        res.status(500).json({ error: error.message });
    }
});
// 1. Fetch Lucky Spin History (For Coffee tab)
app.get('/api/user/spins/:uid', async (req, res) => {
    try {
        const { uid } = req.params;
        let snapshot = await db.collection('spins').where('userId', '==', uid).get();
        if (snapshot.empty) {
            snapshot = await db.collection('spins').where('uid', '==', uid).get();
        }
        const spins = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        spins.sort((a, b) => {
            const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
            const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
            return tb - ta;
        });
        res.json(spins);
    } catch (error) {
        console.error('Spin history route error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 2. Fetch User Profile (For Daily Check-ins / Integral tab)
app.get('/api/user/profile/:uid', async (req, res) => {
    try {
        const { uid } = req.params;
        const doc = await db.collection('users').doc(uid).get();
        if (!doc.exists) return res.status(404).json({ error: "User not found" });
        res.json(doc.data());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 3. Fetch Product Orders (For Product Income / Balance tab)
app.get('/api/user/orders/:uid', async (req, res) => {
    try {
        const { uid } = req.params;
        // First get the user's phone number to find their orders
        const userDoc = await db.collection('users').doc(uid).get();
        if (!userDoc.exists) return res.status(404).json({ error: "User not found" });
        
        const phoneNumber = userDoc.data().phoneNumber;
        
        const snapshot = await db.collection('products')
            .where('userPhone', '==', phoneNumber)
            .get();
            
        const products = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        res.json(products);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// Update User Bank Account Info
app.post('/api/user/update-bank', async (req, res) => {
    try {
        const { uid, bankAccount, phoneNumber, phoneDigits } = req.body;
        
        await db.collection('users').doc(uid).set({
            bankAccount,
            phoneNumber,
            phoneDigits
        }, { merge: true });
        
        res.json({ success: true, message: "Bank info updated" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// Update User Address
app.post('/api/user/update-address', async (req, res) => {
    try {
        const { uid, address } = req.body;
        
        await db.collection('users').doc(uid).set({
            address
        }, { merge: true });
        
        res.json({ success: true, message: "Address updated successfully" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// Change Pay Password (with old password verification)
app.post('/api/user/change-pay-password', async (req, res) => {
    try {
        const { uid, oldPassword, newPassword } = req.body;
        
        const userDoc = await db.collection('users').doc(uid).get();
        if (!userDoc.exists) return res.status(404).json({ error: "User not found" });

        const userData = userDoc.data();

        // Verify old password
        if (userData.payPassword !== oldPassword) {
            return res.status(400).json({ error: "Old password is incorrect" });
        }

        // Update to new password
        await db.collection('users').doc(uid).update({
            payPassword: newPassword
        });

        res.json({ success: true, message: "Pay password updated" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// Change Login Password (Auth)
app.post('/api/user/change-login-password', async (req, res) => {
    try {
        const { uid, oldPassword, newPassword } = req.body;

        // 1. Verify the old password matches what we have in Firestore
        // Note: For login password, you should ideally store it hashed or 
        // check against the user document if you store it there for verification.
        const userDoc = await db.collection('users').doc(uid).get();
        if (!userDoc.exists) return res.status(404).json({ error: "User not found" });

        const userData = userDoc.data();
        if (userData.password !== oldPassword) {
            return res.status(400).json({ error: "Old password is incorrect" });
        }

        // 2. Update the Firebase Auth system password
        await admin.auth().updateUser(uid, {
            password: newPassword
        });

        // 3. Update the password in Firestore user record so they stay in sync
        await db.collection('users').doc(uid).update({
            password: newPassword
        });

        res.json({ success: true, message: "Login password updated" });
    } catch (error) {
        console.error("Error updating login password:", error);
        res.status(500).json({ error: error.message });
    }
});
//product
const PRODUCTS = {
    'samsung-phone': {
        id: 'samsung-phone',
        title: 'Galaxy S23 Ultra',
        category: 'Phone',
        price: 7000,
        originalPrice: 8860,
        discount: 21,
        days: 30,
        images: [
            'https://d2u1z1lopyfwlx.cloudfront.net/thumbnails/d84afaeb-f0d2-59a7-9d8a-8441d2404df0/78b7eb7a-896e-57ff-b047-c69590dd28e7.jpg',
        ],
        description: 'The Samsung Galaxy S23 Ultra is a premium flagship smartphone that masterfully blends powerful performance with sophisticated design effectively carrying on the legacy of the Note series with its integrated S Pen.It features a massive stunning 6.8 - inch Dynamic AMOLED 2 X display with a smooth 120 Hz refresh rate perfect for both productivity and media consumption.At its core the custom "Snapdragon 8 Gen 2 for Galaxy processor ensures top - tier speed and efficiency while its most distinctive feature is the versatile rear camera system headlined by a groundbreaking 200 - megapixel main sensor capable of capturing incredible detail.Complemented by advanced telephoto lenses offering up to 100 x Space Zoom it excels in photography and videography.Housed in a sleek premium armor aluminum frame with a matte finish it also packs a long - lasting 5 000 mAh battery making it a complete and uncompromising flagship experience ',
        features: [
            ' Integrated S Pen',
            '200MP Main Camera',
            'Powerful Telephoto Zoom',
            'Custom Snapdragon Processor',
            ' Large Dynamic Display',
            'Premium Armor Aluminum Design',
            'Long-Lasting Battery',
            'Pro-Grade Video Recording'
        ],
        dailyIncome: 466,
        totalIncome: 14000,
        rating: 4.5,
        reviewCount: 24,
        specifications: [
            { label: 'Processor', value: ' Qualcomm Snapdragon 8 Gen 2 for Galaxy (4nm) Octa-core chipset' },
            { label: 'Display', value: '6.8-inch Dynamic AMOLED 2X, 120Hz refresh rate, 1750 nits peak brightness' },
            { label: 'Rear Camera', value: 'Quad setup with 200MP main + 12MP ultrawide + 10MP telephoto (3x) + 10MP periscope (10x)' },
            { label: 'Front Camera', value: '12MP selfie camera with 4K video recording' },
            { label: 'Zoom Capability', value: 'Up to 100x digital zoom with 10x optical zoom' },
            { label: 'Battery', value: '5000mAh with 45W fast charging' },
            { label: 'RAM', value: '8GB or 12GB options' },
            { label: 'Storage', value: '256GB, 512GB, or 1TB (non-expandable)' }
        ],
        shipping: 'Free shipping within Addis Ababa (1-2 business days). Other regions: 3-5 business days.',
        returnPolicy: '7-day return policy for defective products. Items must be in original condition.',
        warranty: 'Quality guaranteed - if you are not satisfied, contact us within 7 days.',
        related: ['mac-book-pro', 'smart-watch', 'head-phone']
    },
    'mac-book-pro': {
        id: 'mac-book-pro',
        title: 'Mac-Book-Pro ',
        category: 'Computer',
        price: 12000,
        originalPrice: 14520,
        days: 30,
        discount: 21,
        images: [
            'data:image/jpeg;base64,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'
        ],
        description: 'The MacBook Pro (2026) features 14-inch and 16-inch Liquid Retina XDR displays with ProMotion, powered by the revolutionary M5 Pro and M5 Max chips. The M5 Max boasts an 18-core CPU and 48-core GPU with AI accelerators in each core, delivering 8x faster AI performance than M1. It introduces Thunderbolt 5 ports with 120Gb/s transfer speeds, Wi-Fi 7 via the new Apple N1 chip, and a 12MP Center Stage camera. With up to 24 hours of battery life and a sleek design, its built for professionals who need maximum performance without compromise.',
        features: [
            'Revolutionary M5 Pro & M5 Max Chips',
            'Breakthrough AI Performance',
            'Massive Unified Memory',
            'Blazing Fast Storage',
            'Stunning Liquid Retina XDR Display',
            'Professional GPU Options'
        ],
        dailyIncome: 800,
        totalIncome: 24000,
        rating: 4.8,
        reviewCount: 42,
        specifications: [
            { label: 'Processor & Chipset', value: 'M5 Pro with up to 18-core CPU (6 super cores + 12 performance cores) and 16/20-core GPU; M5 Max with up to 18-core CPU and 32/40-core GPU featuring Fusion Architecture' },
            { label: 'Memory & Storage', value: 'M5 Pro supports up to 64GB with 307GB/s bandwidth; M5 Max supports up to 128GB with 614GB/s bandwidth; SSD speeds up to 14.5GB/s with 1TB-8TB options' },
            { label: 'Display', value: '14-inch (3024x1964) or 16-inch (3456x2234) Liquid Retina XDR with Mini-LED, 120Hz ProMotion, 1600 nits peak HDR, and nano-texture glass option' },
            { label: 'Camera & Audio', value: '12MP Center Stage camera with Desk View; six-speaker system with Spatial Audio, force-cancelling woofers, and studio-quality mics' },
            { label: 'Ports & Connectivity', value: 'Three Thunderbolt 5 ports (120Gb/s), HDMI 8K, SDXC, MagSafe 3; Apple N1 chip with Wi-Fi 7 and Bluetooth 6' },
            { label: 'Battery & Power', value: 'Up to 24 hours battery life; 50% charge in 30 minutes with fast charging; 96W or higher adapter support' }
        ],
        shipping: 'Free shipping within Addis Ababa (1-2 business days). Other regions: 3-5 business days.',
        returnPolicy: '7-day return policy for defective products.',
        warranty: 'Quality guaranteed - satisfaction guaranteed.',
        related: ['lllubabor', 'smart-watch', 'tablet']
    },
    'smart-watch': {
        id: 'smart-watch',
        title: 'Smart-Watch',
        category: 'Watch',
        price: 2000,
        originalPrice: 2420,
        days: 30,
        discount: 21,
        images: [
            'data:image/jpeg;base64,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'
        ],
        description: 'A smartwatch is a portable wearable computer in the form of a wristwatch that provides functionality beyond timekeeping . It integrates seamlessly with your smartphone to display notifications, messages, and calls directly on your wrist, while also incorporating advanced sensors for comprehensive health and fitness monitoring . Modern smartwatches track metrics like heart rate, blood oxygen levels (SpO2), sleep stages, and even detect irregular heart rhythms, effectively serving as a personal health hub . With built-in GPS for route tracking, contactless payment options, and voice assistant integration, a smartwatch enhances both connectivity and convenience throughout your day ',
        features: [
            'Health & Fitness Tracking',
            'Built-in GPS',
            'Smartphone Notifications',
            'Activity Tracking',
            'Water Resistance',
            'Long Battery Life',
            'Sleep Tracking'
        ],
        dailyIncome: 133,
        totalIncome: 4000,
        rating: 4.6,
        reviewCount: 31,
        specifications: [
            { label: 'Processor & Chipset', value: 'Qualcomm Snapdragon W5 Gen 1 + BES2800 low-power co-processor' },
            { label: 'Operating System', value: 'Wear OS 6 with Google Gemini pre-installed ' },
            { label: 'Display', value: '1.54-inch AMOLED, 480x480 resolution, 1500 nits peak brightness' },
            { label: 'Battery', value: '930mAh silicon-carbon battery (up to 6 days smart mode / 18 days power saver)' },
            { label: 'Build', value: 'Stainless steel frame, double-sided sapphire glass, 5ATM water resistance ' },
            { label: 'GPU', value: ' Adreno GPU with 7x faster graphics, supporting 1080p at 60fps' }
        ],
        shipping: 'Free shipping within Addis Ababa.',
        returnPolicy: '7-day return policy.',
        warranty: 'Quality guaranteed.',
        related: ['lllubabor', 'mac-book-pro', 'gaming-console']
    },
    'head-phone': {
        id: 'head-phone',
        title: 'Head-Phone ',
        category: 'Head Phone',
        price: 1200,
        originalPrice: 1452,
        days: 30,
        discount: 21,
        images: [
            'data:image/jpeg;base64,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'
        ],
        description: 'Headphones are personal audio devices worn over or in the ears that deliver immersive sound for music, calls, gaming, and entertainment. Modern headphones feature advanced drivers for rich audio quality, active noise cancellation (ANC) to block out ambient noise, and Bluetooth connectivity for wireless freedom. With built-in microphones for hands-free calls, touch controls for easy operation, and long battery life ranging from 20 to 60 hours, they provide both convenience and exceptional sound. Premium models include spatial audio with dynamic head tracking, customizable EQ settings, and comfortable memory foam ear cushions for all-day wear.',
        features: [
            'Active Noise Cancellation (ANC)',
            'Long Battery Life',
            'Touch Controls',
            'Water and Sweat Resistance',
            'Built-in Microphones'
        ],
        dailyIncome: 80,
        totalIncome: 2400,
        rating: 4.7,
        reviewCount: 28,
        specifications: [
            { label: 'Type', value: 'Wireless over-ear headphones' },
            { label: 'Driver', value: '40mm titanium-coated dynamic drivers' },
            { label: 'Audio Codec', value: 'LDAC support (up to 24-bit/96kHz)' },
            { label: 'Noise Cancellation', value: 'Adaptive ANC with hybrid feedforward+feedback system' },
            { label: 'Battery Life', value: 'Up to 135 hours (ANC off)' },
            { label: 'Colors', value: 'Black, White, Pink, Yellow' }
        ],
        shipping: 'Free shipping.',
        returnPolicy: '7-day return policy.',
        warranty: 'Quality guaranteed.',
        related: ['lllubabor', 'mac-book-pro', 'tablet']
    },
    'tablet': {
        id: 'tablet',
        title: 'Tablet ',
        category: 'Tablet',
        price: 4000,
        originalPrice: 9680,
        days: 30,
        discount: 21,
        images: [
            'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxMSEhUSExIVFRUVFhUVFxcVFxUVFxUVFRUYFhUVFRUYHSggGBolHRUVITEhJSkrLi4uFx8zODMtNygtLisBCgoKDg0OGhAQGislHR0tKy0tLS0tLS0tLSstLS0tLS0tLS0tLS0tLS0tLS0tLS0rLS0tLSstLS0tLS0tKystLv/AABEIAOEA4QMBIgACEQEDEQH/xAAcAAABBAMBAAAAAAAAAAAAAAAAAgQFBgMHCAH/xABREAACAQIBAwsOCgYLAQAAAAAAAQIDEQQSIbEFBgcxQVFhcXKRsggTIyQzNFJUc4GSodHhFxgiMlOTwcPi8GJ0g6Kj8RQVFjVCQ2NkgsLSJf/EABoBAQADAQEBAAAAAAAAAAAAAAABAgMEBQb/xAAtEQEAAgIAAwYFBAMAAAAAAAAAAQIDEQQSIRMiMTJBYRQzUYGhBRVi4SNCcf/aAAwDAQACEQMRAD8A3iAAAAAx1W1SjQgpNOUpPJhFbcpPPa+4rJtsB8BXf63xL/wUlwNzfrzCZaq4reoc0/8A0TpG1kA1prt2SKmAgpTjQlJySUI5ak073kvlbStt8KKmtn+pu4KPptEJb3A0ZHqgHu4FfWe4UuqA/wBj/F/CBvEDR/xgF4i/rfwh8YBeIv638IG8ANH/ABgF4i/rfwh8YBeIv638IG8ANH/GAXiL+t/CHxgF4i/rfwgbwA0f8YBeIv638IfGAXiL+t/CBvADR/xgF4i/rfwh8YFeI/xfwgbwA0f8YBeI/wAX8J4+qB/2P8X8IG8QNFS6oCW5gl56jf2GL4f6t+86duXIDfQFT2PdfNHVWjKcY9bqQdp0nJSa2rSW1eLvt2LYAAAAAAAAAAAFd1x98YZcFd+dKnbSyxFf1xLs+GfBWXOoexEwKzT1OxSx0q7xF8O42VK8rL5CVsi2TfLvLLvfPbaJuo8wXE1XmZKrQ+zFJvFQ5D6RQi+7L67Zp8h6ST2P9QcLWwanWoRnPLmspt3stq63SIjck25Y3LV9jw3jPWpgdzCwXpP7RL1p4Lxan+97S3Zyp21WkAN2S1qYLxaHr9on+y2C8Wp+v2loxSrOesNLAbp/sng7d7w9ftBa1MF4vD1+0dlKs8VX6S0sKurWtnvt8G9Y3StaOE8Wh6/aOYa0cBbPhY338rNzW+0dlJHFVn0losDfH9jcD4rD972mOes7BeKw/e9pXklftoaKPTeK1oYLxaHr9p49aWC2v6NT/e9pPZyic9Y9GjgN4vWjgfF4ev2if7JYLxaH73tHZyj4mv0aQPTecdaup+7hYPzyX2le2Q9Q8HRweXQwypzU4JzynK99uytm9ZE0mFq5q2nUF9Tm3/WNX9Xlf6yB0ac5dTp/eFX9Xl04HRpRsAAAAAAAAAACva412fDPgrdGHsLCVvXK+2MNya+in7SYDcRVeZntxFV5mSq0bswrs9Lky0ontjSVsDHl1NKIPZh7tR5M9KJfY6faUfKT05i2PzM806ouCBmCnVF5Rtpycz2SMUkOEJnEtCturDCdhwrPjG0oCqTzpPfWf7S0wziddDulvGbrT3D2h8puOSlkpvhWSr53u3tbznsKe7eyW37Fw3M5axHQm7R7197qMrbyrOKads2fNdXGiq395XW1ubU+LNOUd8aSnd5tsx1N2z5xVKTS2r3LxXTG2TmnRSg7q5kVzDCtv5mZYyvmEorMegcEuEquydC2Blm/zKelltjmzPMVXZQn2g1e/ZKellL+DfDrmgz6nJdv1n/oPpxOijnnqcF27iPIrpo6GOd6AAAAAAAAAAAK3rm74w3JxH3RZCta5++MNycR90TAaXEVXmZ6JqvMyVWlNmKPZaD4KnqcTPrCxGThorcyp6TFsxfPw/FV6URnrSqWoR45aTfhq819ezm4yZjFuPqvUKo5hO5B0Kw/o1jqtR51ciXpCmhvQq7g6ujH1dEdYYmY90cSiY3AmFLRJwqttrK4E9qN8ztv5m0Lp4l22t7cT4N1fnOYI4qe1lP+W0e/0uV75Tu9t8X8yvKtF9HLxLcsq24syW8rbiG+fdEzrvff5/kIyxFUTbbJNK24NqcG828K65Yxue6iYiYZ2mJnbJkX2z3JaMMqouNUlWJg4yk9/wA5Vtktdoy8pT0stSmtsq2ybO+Alm/zKelmV/CXVi88E9Tcu28S/wDRj0zoM596m3vrFeRj0zoI5npAAAAAAAAAAArWujvjDcnEfdFlK1ro74w3JxH3RMBgmJqvMwTE1dpkqtM7MXz8PxVdMCL1tztRjxy6TJTZh+fh+KrpgROt1dhjxy6TOjhPmOfi/lLHh6hI0ahE0CRos9G0PG3+ErhqpJQnmISlKxI0KpzXo3x5D+LFMwxmLUzLTo28lEwscSZgqImFLEXC54xLkW0y29lnMcoi2JGkTG2NMXGZ5Y8RMwppmp1CvbJEr4GXlKelk7creyHO+Cly4aTLJHdl1cPPfg76m3vrFeRh0zoI596m3vrFeRj0zoI43rAAAAAAAAAAArOunvjDcnEaKRZisa6u74bk4jRTJgRyYmq8x4mJqvMyVWndl/5+H4qumA21qUb4aL/SlpHGy8/lYfiraYC9ZVJvCRf6U9J0cJ8xx8fOsP3P6dEeUaZljRZnp0T05no8SLdWOmh7QR4qAuNFoxtMSvWZidnkFmMkYmKlFjjJOeejtpbbywmURYMqvPU3nAwuI6kYpRLxLKasLQmTFyMUy6pLmJyxMkYpslGzhTK7sg95y5cNJMZRAa+ql8JJfpw0meWO7LowT34SvU299YryMOmdBHPvU299YryMemdBHnvWAAAAAAAAAABWNdnd8Nya/wB2Wcq+u3u+G5NfRTJgRKYmq8zPExNR5iVWodl352H4q2mBKbHkL4KPLnpIvZc+dh/22mBJbHjf9Djy56Tbh/O5OPjeH7rTCiZI0OAxwus49pVDttMvFrER4k06bQuVMc0ncVkmE36uquPcGbhZCozMlRcBimktr8+YeKetZZhMkYYVBbkV5erat4mGOZiZ7ORilItCskTRgmxc5mGUjWGdiWzFMVKRjci0Kgr+vjvSXKhpJ+Uiva9n2rLlQ0lMvkltg+ZCb6m3vrFeRh0zoE5+6m3vrFeRh0zoE817AAAAAAAAAAAKvru7vhuTX+7LQVbXf3bDcmv92TAhExNR5meXE1HmJVam2WvnYf8AbaYEjsfd6R5c9JG7LG3h/wBtpgSex93nHlz0muDzsOJjeNaacmOachtTHNM67W08ycOzqhIdpjaCtYzKRy3tuXVjwzWHk0NpxHDziJkVvpa2LZnKNj1reM0omOUTWL7YzjmpvUY2nIc1mxlXkXhWWGpUMMqpjrVBrKsbMrHUqghzGvXjzrpKDrLIHXlLtaXKhpJPrpDa7ZdrS5UdJnl8kujDHfhZupt76xXkYdM6BOfept76xXkYdM6CPNesAAAAAAAAAACq68O7Ybk19FMtRVdePdsNya/3ZMCv3E1HmPLiajzEqtVbK+3h/wBtpgSex/3nHlz0kZsqvPh/22mA/wBYU+1I8uekvinVlMteaultgOqSGFKQ8jPNucd/t2mXyXUx4fU/g1ayFIbUZerctp3uIdQd87/PBwcxyWtqXRFGSG1+dAmojxzSPXO4i3qiaMM1+faYqi/O8O8nNcxuF1mV+LOjWMjK2NHVGMMSiVrx/lm+z7SMxSzHTSzjyU0hsTIYVKhIYsia7OmJc0wV10964NMsVGZbaujrLIrXPLteXHHSPlIjdcb7BLjjpRnl8kujD54XHqbe+sV5GHTOgTn3qbe+sV5GHTOgjzXqgAAAAAAAAAAqmvPu2G5NfRTLWVPXq+y4bk19FMmBW7iajzHlxNR5iVWrtlN58P8AttMBxrKlbCx5U+Dd/PtGeyg/lUf2umBk1oTth48c9+9r59r5q4biJ1K1a7W6hV4s23tWvw774ErDunVvZrPvO2h7vmzIhVW33tbSss3GtqPnux1SqtuzWVJ8ubXGkrFbS2rHpCZhPaXMr30bvEPaMm8yTb3Utzje0uciY1lFWbyd/wCVFt8CUUuZsk6K+Tuxjv1JW9GlFLPwvnOTJd0VxM0otNJuN3+lZJcN1oY6o04+G5b/AFuNl55P7RukpR7GpuG7K0I5X/KXvCNeO1kTlbcdScreaLsUjJuNFsWpSEZx2ou27mWXL159I3rw3WpPhk7ewxLFWzJKK3k7c93nFTndbnNf1+82rtz3iDStHesuLO+f3kbio3/n+WSc8+7fz3941rQ/O6d2KXnZoV7F0yGxESy4qmQuLpHZXwcNuiIkjxMy1YGJosgtSI/XA+wS449JD1MY6v8AcJccekiuXyS0wz/khc+ptfbeJ8jHpnQZz11N77cxC/0V0zoU816wAAAAAAAAAAKjr37rhuKvopluKhr57rhuKvopkwKw2JqPMeXE1HmZKrVuya/l0uKppiGteXa8buyvJvdbz5klucYjZK7pS4p6YnmtuVqEXwys3mjHPne+3xFLzpvgrzW0sUKlrO1vBvJLb3bbd3v5hzSe2s7e27JRSXKkrtcyIyhVztxvwzvz2btbiHMK6StmS/Sk5NvwmlmXMvOYWu7a4kxha+RtThHcvG8533otpLmsuBknhoNZ1SeVtp1Pl1OPIWaPnRB06zuvltNr/DTblbeprM7c24SeAkm7ZFSpvx64lFPfnkWUXxyRyZLOumPSdi5zV6lnyqiivOoXfr8wzxNRbjhZbkKa02zntDJcrXoxlvK9Vx4oZo+dt8ZkrYlJ5OXd/pNSf/GNOLtzmdLdds8tOmjShv8Ars0+ZSQ7g1u9FJ87ziJU4xzyk438Ki1fzuUbnkalP/DLz2UfU27HpY4mzyc1ohlnPj50/sG02ZZrPt5+NX9QiUUd2OmnmZcvUxroi8TSJqpT3BjXpHTWHJa21dxFIZ1KZO4iiR1akaaZcyOaI7V7uEuOOlEvOBFa4F2CXHHpIzyx3JbYJ3kqt/U4d+1/If8AdHQ5zt1OT7er+Q/7o6JPNe0AAAAAAAAAACna+32XDcVfRTLiUzX8+y4Xir6KZMCr3E1HmPGxNR5iVWrdkh9lp8UtMRvqI+wx45bSV38p5nJ5kjNsjd1p8UvsI7U6fYorj3vCe69oyyeDr4Se/wDZOxrbSfyt5XdvMo53oHlKu8yvbeSSzcMaa2uNtEDTqPfduDNfje76zNSq23ObOueWbSYzD0Iss1Cvt7t9tu078rPGnz5Q/o4y9k2mluScpJcUKUVC3OVijiOHP6/M3d+pId0sS3vW4VldN5vUc9qOmswttHVL5OSpJrdhGn1uPnUZXfnQ+pYlpZquQt6nTdue8So08a/CduZeirW9Y/hi9z7E/sGOnVhxHlTksfFXfXKl91pQXO8mT9Zk/rKbWaqnypX0QRX5Yi+6/PuLgzZj1V77b9d9LPbwYo0+T4vLaJT8cY82dea/2U0L69fd5iAjVtuL1Ic0sQdsUh5VsspVtDarD8oxRrLfPXVJ5Ve0k0r0yOr0SVqO40rIk5kNVpkFrljahLjj0kWavEruujuEuOOlGebyS34a09rX/qx9Tm+363kH04nRZzj1Or/+jV/V5dOB0ceU+hAAAAAAAAAABS9kF9lwvFX0Uy6FH2RpWq4X9uvVTJgVdsTPaFCam0Sq1ZsiPssOKX2EVgu5x4n0mSmyJ3WHFL7CqxqyWZSa4mylo21xX5J2m8sy05EB1+XhS52HX5eFLnZXkbfE+y0QrDmlXKd1+XhS52HX5eFLnZHZw0jjJj0X2lWHtOrwmtevy8KXOw69LwnzsiMWvUtxnNGphs2nUHapvJysqFt7KWVt2+btmp+vS8KXOzJBybycqWVtWu9ve29s68ebkeTn4eMs78G0nVzHscQao69LwnzsOvS8J87N/i/Zxz+mb/2/Db8MQLWINO9el4T52HXpeE+dj4z2R+1/y/DcbriJVDT/AF6XhPnYdel4T52Pi/Y/a/5fj+21KzIfXrhYww941Y1MrJuo/wCFprM8/D6mUPr0vCfOzyVWT22352VvxPNWY14tcX6f2d4tzeHs2j1Ov941P1efTgdHnOPU6/3jU/V5dOB0ccj0QAAAAAAAAAAV3XtqBLF0o9bko1aUsuGVmjK6tKDe5fNn30ixABp6Wo2qCzPBzbW9Km15mpCJ6k6oeJVeen/6NyATtGnOuuXWLj8TFWwNVTUrqWVTtktfKi1lb6i77lnmd81dWxRqr4q/SidWAQlystiXVXxf95GSOxBqq/8AJj6XuOpQA5c+B3VT6KHp+4Pgc1U+ih6fuOowA5c+BzVT6KHp+4Pgc1U+ih6fuOowA5c+B3VT6KHp+4z/AATarZWV1qnlW28vgtfa2+HznTgAcufA7qp9FD0/cHwO6qfRQ9P3HUYAcufA7qp9FD0/cHwO6qfRQ9P3HUYAcufA7qp9FD0/cIlsQ6qr/IT4pe46mADlR7E2qvi37yPPgo1V8VfpR9p1YAGtdiHY6lqapV68k69WGQ4KzVOOVdrKTeU3aO8bKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/9k='
        ],
        description: 'The iPad Pro 12.9-inch is Apples flagship tablet built for creative professionals. It features a stunning Liquid Retina XDR display with mini-LED technology, delivering 1600 nits peak brightness and deep blacks. Powered by the M2 chip with 8-core CPU and 10-core GPU, it handles demanding tasks like video editing and 3D design effortlessly. The pro camera system includes 12MP Wide and 10MP Ultra Wide lenses with LiDAR scanner, while the 12MP front camera features Center Stage. With Thunderbolt/USB-4 support, 5G connectivity, and Apple Pencil 2 compatibility, it transforms into a powerful creative studio.',
        features: [
            'Liquid Retina XDR Display',
            'Apple M2 Chip',
            '16-core Neural Engine',
            'Pro Camera System',
            '5G Connectivity',
            'Face ID'
        ],
        dailyIncome: 266,
        totalIncome: 8000,
        rating: 4.9,
        reviewCount: 56,
        specifications: [
            { label: 'Processor', value: 'Apple M2 chip with 8-core CPU and 10-core GPU; 16-core Neural Engine' },
            { label: 'Display', value: '2.9-inch Liquid Retina XDR (mini-LED), 2732 x 2048 resolution at 264 ppi, 120Hz ProMotion, 1000 nits full-screen brightness, 1600 nits peak HDR, 1,000,000:1 contrast ratio' },
            { label: 'Dimensions & Weight', value: '280.6 x 214.9 x 6.4 mm; 682g (Wi-Fi), 684g (5G)' },
            { label: 'Security', value: 'Face ID via TrueDepth camera system ' },
            { label: 'Operating System', value: 'iPadOS (shipped with iPadOS 16, upgradable)' },
            { label: 'Battery', value: 'Up to 10 hours web/video (Wi-Fi), 9 hours (cellular); 40.88 Wh capacity ' }
        ],
        shipping: 'Free shipping.',
        returnPolicy: '7-day return policy.',
        warranty: 'Quality guaranteed.',
        related: ['lllubabor', 'mac-book-pro', 'gaming-console']
    },
    'gaming-console': {
        id: 'gaming-console',
        title: 'Gaming-Console ',
        category: 'Console',
        price: 24000,
        originalPrice: 29040,
        days: 30,
        discount: 11,
        images: [
            'data:image/jpeg;base64,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'
        ],
        description: 'The PS5 Digital Edition is an all-digital version of the PlayStation 5 console, designed for gamers who prefer to download their games rather than buy physical discs . It delivers the exact same core performance as the standard PS5, featuring lightning-fast loading with an ultra-high speed SSD, stunning 4K graphics with ray tracing support, and smooth gameplay at up to 120fps on compatible displays . The console comes with the innovative DualSense wireless controller, which provides immersive haptic feedback and adaptive triggers that let you feel the tension of in-game actions . With a sleek, symmetrical design that slimmer and lighter than the disc version (2.6kg for the Slim model), the Digital Edition is ideal for players who have fully embraced the digital ecosystem and want to access the PlayStation Store for all their gaming needs ',
        features: [
            'Ultra-Fast SSD',
            'Stunning 4K Graphics',
            'DualSense Wireless Controller',
            'HDMI 2.1 Support',
            'Wi-Fi 6 & Bluetooth 5.1'
        ],
        dailyIncome: 1600,
        totalIncome: 48000,
        rating: 5.0,
        reviewCount: 89,
        specifications: [
            { label: 'Processor ', value: 'x86-64 AMD Ryzen "Zen 2", 8 Cores / 16 Threads, up to 3.5 GHz ' },
            { label: 'Graphics ', value: 'AMD RDNA 2-based, 10.3 TFLOPS, Ray Tracing, up to 2.23 GHz' },
            { label: 'Memory ', value: '16GB GDDR6' },
            { label: 'Internal Storage', value: 'Custom 825GB SSD (5.5GB/s read speed)' },
            { label: 'Video Output', value: 'Supports 4K 120Hz, 8K, VRR (HDMI 2.1)' },
            { label: 'Included Controller', value: 'DualSense Wireless Controller ' }
        ],
        shipping: 'Free shipping.',
        returnPolicy: '7-day return policy.',
        warranty: 'Quality guaranteed.',
        related: ['lllubabor', 'tablet', 'smart-watch']
    }
};
const PRODUCT_LIMITS = {
    'samsung-phone': 5,
    'mac-book-pro': 7,
    'smart-watch': 2,
    'head-phone': 1,
    'tablet': 3,
    'gaming-console': 15
};
app.post('/api/purchase', async (req, res) => {
    const { uid, productId } = req.body;
    console.log(`🛒 Processing purchase for UID: ${uid}, Product: ${productId}`);

    try {
        const product = PRODUCTS[productId];
        if (!product) throw new Error("Product not found in server database");

        const userRef = db.collection('users').doc(uid);
        const ordersRef = db.collection('products'); // This is your 'orders' collection

        const transactionResult = await db.runTransaction(async (t) => {
            const userDoc = await t.get(userRef);
            
            if (!userDoc.exists) {
                throw new Error("User does not exist in Firestore. Check if UID matches.");
            }

            const userData = userDoc.data();
            const currentBalance = userData.balance || 0;

            if (currentBalance < product.price) {
                throw new Error(`Insufficient balance. Need ${product.price}, have ${currentBalance}`);
            }

            // 1. Deduct Balance
            t.update(userRef, {
                balance: currentBalance - product.price
            });

            // 2. Prepare Detailed Order Data
            const now = new Date();
            const durationDays = Number.isFinite(product.days)
                ? product.days
                : (parseInt(product.days, 10) || 30);
            const dailyIncome = Number.isFinite(product.dailyIncome)
                ? product.dailyIncome
                : (parseFloat(product.dailyIncome) || 0);
            const totalIncome = dailyIncome * durationDays;
            const endingDate = new Date(now.getTime() + (durationDays * 24 * 60 * 60 * 1000));

            const newOrderRef = ordersRef.doc();

            const userPhone = userData.phoneNumber || userData.phone || 'Unknown';
            const pointsAwarded = Math.floor(parseFloat(product.price) / 10) || 0;

            const orderData = {
                buyingTime: admin.firestore.Timestamp.fromDate(now),
                currentIncome: 0,
                dailyIncome: dailyIncome,
                days: durationDays,
                endingTime: admin.firestore.Timestamp.fromDate(endingDate),
                lastReceive: admin.firestore.Timestamp.fromDate(now),
                pointsAwarded: pointsAwarded,
                productCategory: product.category || 'General',
                productId: productId,
                productName: product.title,
                productPrice: product.price,
                status: 'active',
                totalEarnings: 0,
                totalIncome: totalIncome,
                userId: uid,
                userPhone: userPhone
            };

            // 3. Create Order
            t.set(newOrderRef, orderData);

            return { 
                success: true, 
                newBalance: currentBalance - product.price,
                orderId: newOrderRef.id 
            };
        });

        console.log(`✅ Database Updated for ${uid}`);
        res.json(transactionResult);

    } catch (error) {
        // This log will now show up in your Render Logs!
        console.error("❌ TRANSACTION ERROR:", error.message); 
        res.status(400).json({ success: false, error: error.message });
    }
});
app.get('/api/products/:id', (req, res) => {
    const productId = req.params.id;
    const product = PRODUCTS[productId];

    if (product) {
        // Find the full data for each related product ID
        const relatedData = (product.related || []).map(id => {
            const p = PRODUCTS[id];
            return p ? { id: p.id, title: p.title, price: p.price, images: p.images } : null;
        }).filter(item => item !== null);

        // Send the product PLUS the detailed related products
        res.json({ ...product, relatedData });
    } else {
        res.status(404).json({ error: "Product not found" });
    }
});
// GET TEAM STATS AND MEMBERS
app.get('/api/team-stats/:uid', async (req, res) => {
    try {
        const uid = req.params.uid;
        
        // 1. Get the current user's referral code
        const userDoc = await db.collection('users').doc(uid).get();
        if (!userDoc.exists) {
            return res.status(404).json({ error: "User not found" });
        }
        
        const userData = userDoc.data();
        const myCode = userData.myReferralCode || 'N/A';

        // 2. Query for all users who used this code as their inviteCode
        const referralsSnapshot = await db.collection('users')
            .where('inviteCode', '==', myCode)
            .get();

        let teamRevenueTotal = 0;
        const members = [];

        referralsSnapshot.forEach(doc => {
            const data = doc.data();
            const balance = data.balance || 0;
            teamRevenueTotal += balance;

            // Secure the phone number: only show last 4 digits
            const rawPhone = data.phoneNumber || data.phone || 'Unknown';
            const maskedPhone = rawPhone.length > 4 ? `****${rawPhone.slice(-4)}` : '****';

            members.push({
                maskedPhone: maskedPhone,
                balance: balance
            });
        });

        // 3. Return consolidated data
        res.json({
            myReferralCode: myCode,
            referralCount: referralsSnapshot.size,
            teamRevenueTotal: teamRevenueTotal,
            members: members
        });

    } catch (error) {
        console.error("❌ Team API Error:", error.message);
        res.status(500).json({ error: "Failed to fetch team data" });
    }
});
// 5. START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
