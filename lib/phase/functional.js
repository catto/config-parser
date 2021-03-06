'use strict';

const Joi = require('joi');
const Hoek = require('hoek');
const clone = require('clone');

// Actual environment size is limited by space, not quantity.
// We do this to force sd.yaml to be simpler.
const MAX_ENVIRONMENT_VARS = 25;
// If they are trying to execute >25 permutations,
// maybe there is a better way to accomplish their goal.
const MAX_PERMUTATIONS = 25;

/**
 * Generate the default list of jobs (normal order without main)
 * @method getDefaultWorkflow
 * @param  {Object}           jobs Object of jobName => jobDefinition
 * @return {Array}                 List of jobs in order of definition (without main)
 */
function getDefaultWorkflow(jobs) {
    const jobNames = Object.keys(jobs);

    // Remove main
    jobNames.splice(jobNames.indexOf('main'), 1);

    return jobNames;
}

/**
 * Make sure the Matrix they specified is valid
 * @method validateJobMatrix
 * @param  {Object}      job     Job to inspect
 * @param  {String}      prefix  Prefix before reporting errors
 * @return {Array}               List of errors
 */
function validateJobMatrix(job, prefix) {
    let matrixSize = 1;
    const errors = [];
    const matrix = Hoek.reach(job, 'matrix', {
        default: {}
    });
    const environment = Hoek.reach(job, 'environment', {
        default: {}
    });
    const environmentSize = Object.keys(matrix).length + Object.keys(environment).length;

    if (environmentSize > MAX_ENVIRONMENT_VARS) {
        errors.push(`${prefix}: "environment" and "matrix" can only have a combined ` +
            ` maxiumum of ${MAX_ENVIRONMENT_VARS} environment variables defined ` +
            `(currently ${environmentSize})`);
    }

    Object.keys(matrix).forEach((row) => {
        matrixSize *= matrix[row].length;
    });

    if (matrixSize > MAX_PERMUTATIONS) {
        errors.push(`${prefix}: "matrix" cannot contain >${MAX_PERMUTATIONS} permutations ` +
            `(currently ${matrixSize})`);
    }

    return errors;
}

/**
 * Make sure the Steps are possible
 *  - Check it doesn't start with sd-
 * @method validateJobSteps
 * @param  {Object}      job     Job to inspect
 * @param  {String}      prefix  Prefix before reporting errors
 * @return {Array}               List of errors
 */
function validateJobSteps(job, prefix) {
    const errors = [];
    const steps = Hoek.reach(job, 'commands', {
        default: []
    });

    steps.forEach((step) => {
        if (step.name.indexOf('sd-') === 0) {
            errors.push(`${prefix}: Step "${step.name}": `
                + 'cannot use a restricted prefix "sd-"');
        }
    });

    return errors;
}

/**
 * Ensure the job is something that can be run
 *  - has at least one step
 *  - the image name
 *  - not too many environment variables
 * @method validateJobSchema
 * @param  {Object}          doc Document that went through flattening
 * @return {Array}               List of errors
 */
function validateJobSchema(doc) {
    let errors = [];

    // Jobs
    const SCHEMA_JOB = Joi.object()
        .keys({
            commands: Joi.array().min(1).required(),
            image: Joi.string().required(),
            environment: Joi.object().max(MAX_ENVIRONMENT_VARS).default({})
        })
        .unknown(true)
        // Add documentation
        .options({
            language: {
                object: {
                    min: 'requires at least one step',
                    max: `can only have ${MAX_ENVIRONMENT_VARS} environment variables defined`
                }
            }
        });

    // Validate jobs contain required minimum fields
    Object.keys(doc.jobs).forEach((jobName) => {
        const prefix = `Job "${jobName}"`;

        try {
            Joi.attempt(doc.jobs[jobName], SCHEMA_JOB, prefix);
        } catch (err) {
            errors.push(err.message);
        }

        errors = errors.concat(validateJobMatrix(doc.jobs[jobName], prefix));
        errors = errors.concat(validateJobSteps(doc.jobs[jobName], prefix));
    });

    return errors;
}

/**
 * Get the defined workflow, or if missing generate one (list of all jobs in series)
 * @method generateWorkflow
 * @param  {Object}          doc Document that went through flattening
 * @return {Array}               Workflow of jobs
 */
function generateWorkflow(doc) {
    // Default to the list of jobs
    return Hoek.reach(doc, 'workflow', {
        default: getDefaultWorkflow(doc.jobs)
    });
}

/**
 * Ensure the workflow is a valid one
 *  - Contains all defined jobs (no extra or missing)
 *  - Main is first
 * @method validateWorkflow
 * @param  {Object}          doc Document that went through flattening
 * @return {Array}               List of errors
 */
function validateWorkflow(doc) {
    // Validate that main is not included
    if (doc.workflow.indexOf('main') > -1) {
        return ['Workflow: "main" is implied as the first job and must be excluded'];
    }
    // Validate that workflow contains just the jobs in `jobs`
    // @TODO Support complex workflow like series and parallel
    const sortedJobList = JSON.stringify(clone(getDefaultWorkflow(doc.jobs)).sort());
    const sortedWorkflow = JSON.stringify(clone(doc.workflow).sort());

    if (sortedWorkflow !== sortedJobList) {
        return ['Workflow: must contain all the jobs listed in "jobs"'];
    }

    return [];
}

/**
 * Functional Phase
 *
 * Now that we have a constant list of jobs, this phase is for validating that the
 * jobs will execute as specified.  This is going to be mostly business logic like
 * too many environment variables or must have all jobs in the workflow.
 * @method
 * @param  {Object}   flattenedDoc Document that went through flattening
 * @param  {Function} callback     Function to call when done (err, doc)
 */
module.exports = (flattenedDoc, callback) => {
    const doc = flattenedDoc;
    let errors = [];

    // Jobs
    errors = errors.concat(validateJobSchema(doc));

    // Workflow
    doc.workflow = generateWorkflow(doc);
    errors = errors.concat(validateWorkflow(doc));

    if (errors.length > 0) {
        callback(new Error(errors.join('\n')));
    } else {
        callback(null, doc);
    }
};
