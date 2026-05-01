require('dotenv').config();
const { generateWeeklyReport } = require('./services/callerService');

async function testReport() {
    const uid = 'xjbCgWjzmnYQubalFccIjPCt9QQ2';
    console.log(`Generating and sending report for ${uid}...`);
    try {
        const reportText = await generateWeeklyReport(uid);
        if (reportText) {
            console.log('Report successfully generated and SMS triggered:');
            console.log(reportText);
        } else {
            console.log('Report returned null. Check if the user exists and has a caregiver or doctor phone number.');
        }
        // Wait a few seconds to allow Twilio SMS promises to complete
        setTimeout(() => process.exit(0), 3000);
    } catch (err) {
        console.error('Error:', err);
        process.exit(1);
    }
}

testReport();
