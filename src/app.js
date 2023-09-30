const express = require('express');
const bodyParser = require('body-parser');
const { sequelize } = require('./model')
const { getProfile } = require('./middleware/getProfile')
const app = express();
app.use(bodyParser.json());
app.set('sequelize', sequelize)
app.set('Op', sequelize.Op)
app.set('models', sequelize.models)
const Op = sequelize.Sequelize.Op;
/**
 * 
 * @returns contract by id
 */
app.get('/contracts/:id', getProfile, async (req, res) => {
    const { Contract } = req.app.get('models')
    const { id } = req.params
    profile = req.profile
    if (!profile) return res.status(404).end()

    contract = await Contract.findOne({ where: { id } })

    if (contract) {
        if (profile.type === 'client') {
            if (contract.ClientId != profile.id) {
                contract = null
            }
        }
        if (profile.type === 'contractor') {
            if (contract.ContractorId != profile.id) {
                contract = null
            }
        }
    }

    if (!contract) return res.status(404).end()
    res.json(contract)
})


/**
 * 
 * @returns list of contracts from a user either a Client or Contract in the context
 */
app.get('/contracts', getProfile, async (req, res) => {
    const { Contract } = req.app.get('models')
    profile = req.profile
    contracts = []
    if (!profile) return res.json(contracts).end()

    filterField = ''
    if (profile.type === 'client') {
        filterField = 'ClientId'
    } else if (profile.type === 'contractor') {
        filterField = 'ContractorId'
    }

    contracts = await Contract.findAll({
        where: {
            [filterField]: profile.id,
            status: { [Op.not]: 'terminated' }
        }
    })

    res.json(contracts)
})


/**
 * 
 * @returns list of unpaid jobs from a user either a Client or Contract
 */
app.get('/jobs/unpaid', getProfile, async (req, res) => {
    const { Job } = req.app.get('models')
    const { Contract } = req.app.get('models')
    profile = req.profile
    jobs = []
    if (!profile) return res.json(jobs).end()

    filterField = ''
    if (profile.type === 'client') {
        filterField = '$Contract.ClientId$'
    } else if (profile.type === 'contractor') {
        filterField = '$Contract.ContractorId$'
    }

    jobs = await Job.findAll({
        include: Contract,
        required: true,
        right: true,
        where: {
            [filterField]: profile.id,
            '$Contract.status$': { [Op.not]: 'terminated' },
            paid: { [Op.not]: true }
        }
    })

    res.json(jobs)
})


/**
 * 
 * Pay for a job, a client can only pay if his balance >= the amount to pay. 
 * The amount should be moved from the client's balance to the contractor balance.
 */
app.post('/jobs/:job_id/pay', getProfile, async (req, res) => {
    const { Job } = req.app.get('models')
    const { Contract } = req.app.get('models')
    const { Profile } = req.app.get('models')
    const job_id = req.params.job_id
    profile = req.profile
    if (!profile) return res.status(404).end()

    // contractor = job.Contract.Contractor
    // job.paid = null
    // job.paymentDate = null
    // await job.save(['paid', 'paymentDate'])
    // profile.balance = 231.11
    // await profile.save()
    // contractor.balance = 64
    // await profile.save()


    const t = await sequelize.transaction();

    try {

        job = await Job.findOne({
            include: { all: true, nested: true },
            where: {
                id: [job_id]
            },
            lock: true, transaction: t
        })

        profileUpdate = await Profile.findOne({ where: { id: [profile.id] }, lock: true, transaction: t })

        if (profileUpdate.id != job.Contract.ClientId) {
            throw new Error('You can only pay your own contracts.')
        }
        if (job.paid) {
            throw new Error('This job is already paid.')
        }
        if (profileUpdate.balance < job.price) {
            throw new Error('Job cannot be paid, Insufficient funds')
        }

        profileUpdate.balance = (profileUpdate.balance - job.price).toFixed(2)
        await profileUpdate.save({ transaction: t })

        contractor = job.Contract.Contractor
        contractor.balance = (contractor.balance + job.price).toFixed(2)
        await contractor.save({ transaction: t })

        job.paid = true
        job.paymentDate = Date.now()
        await job.save({ transaction: t })

        await t.commit();

    } catch (error) {
        // If the execution reaches this line, an error was thrown.
        // We rollback the transaction.
        await t.rollback();
        return res.status(500).send({ 'error': error.message })
    }

    res.json({ success: "Job paid Successfully", status: 200 });
})



/**
 * 
 * @returns Deposits money into the the the balance of a client, 
 * a client can't deposit more than 25% his total of jobs to pay. 
 * (at the deposit moment)
 */
app.post('/balances/deposit/:userId', getProfile, async (req, res) => {
    const { Job } = req.app.get('models')
    const { Contract } = req.app.get('models')
    const { Profile } = req.app.get('models')
    const LIMIT_DEPOSIT_PERCENTAGE = 0.25
    const userId = req.params.userId
    const deposit = req.body.deposit
    profile = req.profile
    jobs = []
    if (!profile) return res.json(jobs).end()

    const t = await sequelize.transaction();

    try {

        user = await Profile.findOne({ where: { id: [userId] }, lock: true, transaction: t })

        sql_sum = "SELECT SUM(Jobs.price) AS sum FROM Jobs INNER JOIN Contracts ON Jobs.ContractId = Contracts.id WHERE Jobs.paid IS NULL AND Contracts.ClientId=?;"
        result_sum = await sequelize.query(
            sql_sum,
            {
                replacements: [profile.id],
            },
        );
        total_jobs = null
        total_jobs = result_sum[0][0].sum
        if (!total_jobs || total_jobs < 0 || (deposit > (total_jobs * LIMIT_DEPOSIT_PERCENTAGE))) {
            return res.status(422).send({ 'error': 'Insuficient funds to deposit' })
        }

        profile.balance = (profile.balance - deposit).toFixed(2)
        await profile.save({ transaction: t })

        user.balance = (user.balance + deposit).toFixed(2)
        await user.save({ transaction: t })

        await t.commit();

    } catch (error) {
        // If the execution reaches this line, an error was thrown.
        // We rollback the transaction.
        await t.rollback();
        return res.status(500).send({ 'error': error.message })
    }

    res.json({ success: "Deposit Successfully", status: 200 });
})


function isDateValid(dateStr) {
    return !isNaN(new Date(dateStr));
}

/**
 * 
 * @returns Returns the profession that earned the most money (sum of jobs paid) 
 * for any contactor that worked in the query time range.
 */
app.get('/admin/best-profession', getProfile, async (req, res) => {
    startDate = req.query.start
    endDate = req.query.end

    if (!isDateValid(req.query.start) || !isDateValid(req.query.end)) {
        return res.status(422).send({ 'error': 'Please inform Start and End Date.' })
    }

    startDate = new Date(startDate)
    endDate = new Date(endDate)
    endDate.setDate(endDate.getDate() + 1)

    sqlBestProfession = "SELECT SUM(Jobs.price) AS total, Profiles.profession AS profession FROM Jobs " +
        " INNER JOIN Contracts on Jobs.ContractId = Contracts.id " +
        " JOIN Profiles on Contracts.ClientId = Profiles.id " +
        " WHERE Jobs.paid = 1 and " +
        " Jobs.paymentDate > :start and " +
        " Jobs.paymentDate < :end " +
        " GROUP BY Profiles.profession " +
        " ORDER BY sum(Jobs.price) DESC LIMIT 1;"

    resultBestProfession = await sequelize.query(
        sqlBestProfession,
        {
            replacements: { start: startDate, end: endDate },
        },
    );

    bestProfession = resultBestProfession[0][0]

    res.json(bestProfession);
})


/**
 * @param  start=<date> end=<date> limit=<integer>
 * @returns returns the clients the paid the most for jobs in the query 
 * time period. limit query parameter should be applied, default limit is 2.
 */
app.get('/admin/best-clients', getProfile, async (req, res) => {
    startDate = req.query.start
    endDate = req.query.end
    limit = req.query.limit

    if (!isDateValid(req.query.start) || !isDateValid(req.query.end)) {
        return res.status(422).send({ 'error': 'Please inform Start and End Date.' })
    }

    if (isNaN(limit)) {
        limit = 2
    }

    startDate = new Date(startDate)
    endDate = new Date(endDate)
    endDate.setDate(endDate.getDate() + 1)

    sqlBestClients = "SELECT SUM(Jobs.price) AS total, Profiles.id AS id, Profiles.firstName || ' ' || profiles.lastName AS name  " +
        " FROM Jobs INNER JOIN Contracts on Jobs.ContractId = Contracts.id " +
        " JOIN Profiles ON Contracts.ClientId = Profiles.id " +
        " WHERE Jobs.paid =  1 " +
        " AND Jobs.paymentDate > :start " +
        " AND Jobs.paymentDate < :end " +
        " GROUP BY Contracts.ClientId ORDER BY sum(Jobs.price) DESC LIMIT :limitvalue ;"

    resultBestClients = await sequelize.query(
        sqlBestClients,
        {
            replacements: { start: startDate, end: endDate, limitvalue: limit },
        },
    );
    bestClients = resultBestClients[0]
    res.json(bestClients);
})


module.exports = app;
