const cron = require('node-cron');
const twilio = require('twilio');
const admin = require('firebase-admin');
const fetch = require('node-fetch');

// Ensure to handle the possibility of credentials not being set initially 
if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    try {
        const serviceAccount = require(`../${process.env.GOOGLE_APPLICATION_CREDENTIALS}`);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
    } catch (err) {
        console.error('Failed to initialize Firebase:', err);
    }
}

const twilioClient = process.env.TWILIO_ACCOUNT_SID ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN) : null;

async function makeCall(phoneNumber, medicineName, uid) {
    if (!twilioClient) {
        console.warn('Twilio not configured, skipping call.');
        return;
    }

    let lang = 'en';
    try {
        if (admin.apps.length) {
            const db = admin.firestore();
            const profileDoc = await db.collection('users').doc(uid).collection('profile').doc('data').get();
            if (profileDoc.exists) {
                const pref = profileDoc.data().preferredLanguage;
                if (pref === 'hi') lang = 'hi';
                else if (pref === 'mr') lang = 'mr';
            }
        }
    } catch (err) {
        console.error('Error fetching preferredLanguage:', err);
    }
    
    const url = `${process.env.SERVER_URL || 'http://localhost:3000'}/call/start?medicineName=${encodeURIComponent(medicineName)}&uid=${encodeURIComponent(uid)}&lang=${lang}`;

    twilioClient.calls.create({
        url: url,
        to: phoneNumber,
        from: process.env.TWILIO_PHONE_NUMBER
    }).then(call => {
        console.log(`Call initiated to ${phoneNumber}, callSid: ${call.sid}`);
        
        // After 30 sec check callSid status
        setTimeout(async () => {
             try {
                 const fetchedCall = await twilioClient.calls(call.sid).fetch();
                 const status = fetchedCall.status;
                 console.log(`Call status after 30s: ${status}`);
                 
                 if (['no-answer', 'busy', 'failed'].includes(status)) {
                     await twilioClient.messages.create({
                         body: `ElderEase Reminder: Time to take ${medicineName}.`,
                         from: process.env.TWILIO_PHONE_NUMBER,
                         to: phoneNumber
                     });
                     console.log(`Sent SMS reminder for ${medicineName} to ${phoneNumber}.`);
                 }
             } catch (err) {
                 console.error(`Error checking call status for ${call.sid}:`, err);
             }
        }, 30 * 1000);
        
        // NEW logic: 30 mins check
        setTimeout(async () => {
             try {
                 if (!admin.apps.length) return;
                 const db = admin.firestore();
                 const today = new Date().toISOString().split('T')[0];
                 
                 let isPending = false;
                 
                 // Check medicinelogs/{today}
                 const logDoc = await db.collection('medicinelogs').doc(today).get();
                 if (logDoc.exists) {
                     const data = logDoc.data();
                     if (data.status === 'pending') isPending = true;
                     else if (data[uid] && data[uid].status === 'pending') isPending = true;
                     else if (data[uid] && data[uid][medicineName] && data[uid][medicineName].status === 'pending') isPending = true;
                     else if (Array.isArray(data.logs)) {
                         const log = data.logs.find(l => l.uid === uid && (l.medicineName === medicineName || l.medicine === medicineName));
                         if (log && log.status === 'pending') isPending = true;
                     }
                 }
                 
                 // Fallback check
                 const userLogDoc = await db.collection('users').doc(uid).collection('medicinelogs').doc(today).get();
                 if (userLogDoc.exists && userLogDoc.data().status === 'pending') {
                     isPending = true;
                 }
                 
                 if (isPending) {
                     console.log(`Log status still pending after 30 mins for ${uid}. Sending no response SMS.`);
                     await sendCaregiverSMS(uid, medicineName, 'no response');
                 }
             } catch (err) {
                 console.error(`Error checking log status after 30 mins for ${call.sid}:`, err);
             }
        }, 30 * 60 * 1000);
        
    }).catch(err => {
        console.error(`Error initiating call to ${phoneNumber}:`, err);
    });
}

async function sendCaregiverSMS(uid, medicineName, status) {
    try {
        if (!admin.apps.length || !twilioClient) return;
        const db = admin.firestore();
        const userDoc = await db.collection('users').doc(uid).collection('profile').doc('data').get();
        if (userDoc.exists) {
            const userData = userDoc.data();
            const elderName = userData.displayName || 'The elder';
            const contacts = userData.emergencyContacts || [];
            if (contacts.length > 0 && contacts[0].phone) {
                const caregiverPhone = contacts[0].phone;
                let messageBody = '';
                if (status === 'taken') {
                    messageBody = `ElderEase: ${elderName} has taken their ${medicineName}.`;
                } else if (status === 'not taken') {
                    messageBody = `ElderEase: ${elderName} has NOT taken their ${medicineName}.`;
                } else if (status === 'no response') {
                    messageBody = `ElderEase: ${elderName} did not respond to the reminder.`;
                }
                
                if (messageBody) {
                    await twilioClient.messages.create({
                        body: messageBody,
                        from: process.env.TWILIO_PHONE_NUMBER,
                        to: caregiverPhone
                    });
                    console.log(`Caregiver SMS sent for ${elderName} (${status})`);
                }
            }
        }
    } catch (err) {
        console.error('Error sending caregiver SMS:', err);
    }
}

function scheduleCallback(uid, medicineName, minutes) {
    setTimeout(async () => {
        try {
            if (!admin.apps.length) return;
            const db = admin.firestore();
            const userDoc = await db.collection('users').doc(uid).collection('profile').doc('data').get();
            
            if (userDoc.exists) {
                const phoneNumber = userDoc.data().phoneNumber;
                if (phoneNumber) {
                    console.log(`Scheduling callback for ${uid} in ${minutes} mins...`);
                    makeCall(phoneNumber, medicineName, uid);
                }
            }
        } catch (error) {
            console.error(`Error in scheduled callback for ${uid}:`, error);
        }
    }, minutes * 60 * 1000);
}

async function generateWeeklyReport(uid) {
    if (!admin.apps.length || !twilioClient) return null;
    const db = admin.firestore();
    
    const todayDate = new Date();
    const dates = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date(todayDate);
        d.setDate(d.getDate() - i);
        dates.push(d.toISOString().split('T')[0]);
    }
    const startDate = dates[0];
    const endDate = dates[dates.length - 1];

    try {
        const userDoc = await db.collection('users').doc(uid).collection('profile').doc('data').get();
        if (!userDoc.exists) return null;
        const userData = userDoc.data();
        const elderName = userData.displayName || 'The elder';
        const caregiverPhone = (userData.emergencyContacts && userData.emergencyContacts.length > 0) ? userData.emergencyContacts[0].phone : null;
        const doctorPhone = userData.doctorPhone || null;

        let totalScheduled = 0;
        let totalTaken = 0;
        let totalMissed = 0;

        let morningSugarSum = 0;
        let morningSugarCount = 0;
        let eveningSugarSum = 0;
        let eveningSugarCount = 0;
        let missingSugarDays = 0;

        for (const date of dates) {
            // Medicine logs
            const medLogDoc = await db.collection('users').doc(uid).collection('medicinelogs').doc(date).get();
            if (medLogDoc.exists) {
                const medData = medLogDoc.data();
                const medEntries = medData.logs || Object.values(medData);
                for (const entry of medEntries) {
                    if (entry && typeof entry === 'object' && entry.status) {
                        totalScheduled++;
                        if (entry.status === 'taken') totalTaken++;
                        else if (entry.status === 'not taken' || entry.status === 'missed' || entry.status === 'pending') totalMissed++;
                    }
                }
            }
            
            // Sugar logs
            const sugarLogDoc = await db.collection('users').doc(uid).collection('sugarlogs').doc(date).get();
            let hasSugarReading = false;
            if (sugarLogDoc.exists) {
                const sugarData = sugarLogDoc.data();
                if (sugarData.morning) {
                    morningSugarSum += Number(sugarData.morning);
                    morningSugarCount++;
                    hasSugarReading = true;
                }
                if (sugarData.evening) {
                    eveningSugarSum += Number(sugarData.evening);
                    eveningSugarCount++;
                    hasSugarReading = true;
                }
                
                if (Array.isArray(sugarData.readings)) {
                    for (const reading of sugarData.readings) {
                        if (reading.time === 'morning' || reading.type === 'morning') {
                            morningSugarSum += Number(reading.value);
                            morningSugarCount++;
                            hasSugarReading = true;
                        } else if (reading.time === 'evening' || reading.type === 'evening') {
                            eveningSugarSum += Number(reading.value);
                            eveningSugarCount++;
                            hasSugarReading = true;
                        }
                    }
                }
            }
            if (!hasSugarReading) {
                missingSugarDays++;
            }
        }
        
        let adherence = totalScheduled > 0 ? Math.round((totalTaken / totalScheduled) * 100) : 0;
        let avgMorning = morningSugarCount > 0 ? Math.round(morningSugarSum / morningSugarCount) : 0;
        let avgEvening = eveningSugarCount > 0 ? Math.round(eveningSugarSum / eveningSugarCount) : 0;
        
        const reportText = `ElderEase Weekly Report - ${elderName}\nPeriod: ${startDate} to ${endDate}\n\nMEDICINES:\nTaken: ${totalTaken} | Missed: ${totalMissed} | Adherence: ${adherence}%\n\nSUGAR LEVELS (avg):\nMorning: ${avgMorning > 0 ? avgMorning : 'N/A'} mg/dL | Evening: ${avgEvening > 0 ? avgEvening : 'N/A'} mg/dL\n\nGenerated by ElderEase`;

        await db.collection('users').doc(uid).collection('reports').doc(endDate).set({
            generatedAt: admin.firestore.FieldValue.serverTimestamp(),
            period: `${startDate} to ${endDate}`,
            medicineAdherence: adherence,
            sugarAverage: {
                morning: avgMorning > 0 ? avgMorning : null,
                evening: avgEvening > 0 ? avgEvening : null
            },
            fullReportText: reportText
        });

        const sendSms = async (phone) => {
            if (phone) {
                try {
                    await twilioClient.messages.create({
                        body: reportText,
                        from: process.env.TWILIO_PHONE_NUMBER,
                        to: phone
                    });
                } catch (err) {
                    console.error(`Failed to send report SMS to ${phone}:`, err);
                }
            }
        };

        if (caregiverPhone) await sendSms(caregiverPhone);
        if (doctorPhone) await sendSms(doctorPhone);

        return reportText;

    } catch (err) {
        console.error(`Error generating weekly report for ${uid}:`, err);
        return null;
    }
}

function startCallerService() {
    console.log('Caller Service started...');
    
    // node-cron every Sunday at 9:00 AM for weekly reports
    cron.schedule('0 9 * * 0', async () => {
        console.log('Running weekly report cron job...');
        try {
            if (!admin.apps.length) return;
            const db = admin.firestore();
            const usersSnapshot = await db.collection('users').get();
            for (const userDoc of usersSnapshot.docs) {
                await generateWeeklyReport(userDoc.id);
            }
        } catch (err) {
            console.error('Error in weekly report cron:', err);
        }
    });

    // node-cron every minute
    cron.schedule('* * * * *', async () => {
        const now = new Date();
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const currentTime = `${hours}:${minutes}`;
        
        console.log(`Cron triggered at ${currentTime}, checking medicines...`);
        
        try {
            if (!admin.apps.length) {
                console.warn('Firebase admin not initialized, skipping cron task');
                return;
            }
            
            const db = admin.firestore();
            const usersSnapshot = await db.collection('users').get();
            
            for (const userDoc of usersSnapshot.docs) {
                const uid = userDoc.id;
                const profileDataDoc = await db.collection('users').doc(uid).collection('profile').doc('data').get();
                
                if (profileDataDoc.exists) {
                    const userData = profileDataDoc.data();
                    const phoneNumber = userData.phoneNumber;
                    const medicines = userData.medicines || []; // expected: [{ name: "Aspirin", times: ["08:00", "20:00"] }]
                    
                    if (phoneNumber && Array.isArray(medicines)) {
                        medicines.forEach(medicine => {
                            if (Array.isArray(medicine.times) && medicine.times.includes(currentTime)) {
                                const medName = medicine.name || 'your medicine';
                                console.log(`Match found! Calling ${phoneNumber} for ${medName}`);
                                makeCall(phoneNumber, medName, uid);
                                
                                // Send push notification
                                if (userData.expoPushToken) {
                                    fetch('https://exp.host/--/api/v2/push/send', {
                                        method: 'POST',
                                        headers: {
                                            'Accept': 'application/json',
                                            'Accept-encoding': 'gzip, deflate',
                                            'Content-Type': 'application/json',
                                        },
                                        body: JSON.stringify({
                                            to: userData.expoPushToken,
                                            title: "Medicine Reminder 💊",
                                            body: `Time to take ${medName}`
                                        })
                                    }).then(res => res.json())
                                      .then(data => console.log(`Push notification sent to ${uid}:`, data))
                                      .catch(err => console.error(`Error sending push notification to ${uid}:`, err));
                                }
                            }
                        });
                    }
                }
            }
            
        } catch (err) {
            console.error('Error reading Firestore users:', err);
        }
    });
}

module.exports = { startCallerService, makeCall, scheduleCallback, sendCaregiverSMS, generateWeeklyReport };
