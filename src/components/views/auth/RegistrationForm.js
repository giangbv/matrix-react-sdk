/*
Copyright 2015, 2016 OpenMarket Ltd
Copyright 2017 Vector Creations Ltd
Copyright 2018, 2019 New Vector Ltd

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import React from 'react';
import PropTypes from 'prop-types';
import sdk from '../../../index';
import Email from '../../../email';
import Modal from '../../../Modal';
import { _t } from '../../../languageHandler';
import { SAFE_LOCALPART_REGEX } from '../../../Registration';
import withValidation from '../elements/Validation';
import { ValidatedServerConfig } from '../../../utils/AutoDiscoveryUtils';
import SdkConfig from '../../../SdkConfig';

const FIELD_EMAIL = 'field_email';
const FIELD_USERNAME = 'field_username';
const FIELD_PASSWORD = 'field_password';
const FIELD_PASSWORD_CONFIRM = 'field_password_confirm';

const PASSWORD_MIN_SCORE = 3; // safely unguessable: moderate protection from offline slow-hash scenario.

/**
 * A pure UI component which displays a registration form.
 */
module.exports = React.createClass({
    displayName: 'RegistrationForm',

    propTypes: {
        // Values pre-filled in the input boxes when the component loads
        defaultEmail: PropTypes.string,
        defaultUsername: PropTypes.string,
        defaultPassword: PropTypes.string,
        onRegisterClick: PropTypes.func.isRequired, // onRegisterClick(Object) => ?Promise
        onEditServerDetailsClick: PropTypes.func,
        flows: PropTypes.arrayOf(PropTypes.object).isRequired,
        serverConfig: PropTypes.instanceOf(ValidatedServerConfig).isRequired,
        canSubmit: PropTypes.bool
    },

    getDefaultProps: function() {
        return {
            onValidationChange: console.error,
            canSubmit: true
        };
    },

    getInitialState: function() {
        return {
            // Field error codes by field ID
            fieldValid: {},
            username: '',
            email: '',
            password: '',
            passwordConfirm: '',
            passwordComplexity: null,
            passwordSafe: false
        };
    },

    onSubmit: async function(ev) {
        ev.preventDefault();

        if (!this.props.canSubmit) return;

        const allFieldsValid = await this.verifyFieldsBeforeSubmit();
        if (!allFieldsValid) {
            return;
        }

        const self = this;
        if (this.state.email == '') {
            const QuestionDialog = sdk.getComponent('dialogs.QuestionDialog');
            Modal.createTrackedDialog(
                "If you don't specify an email address...",
                '',
                QuestionDialog,
                {
                    title: _t('Warning!'),
                    description: (
                        <div>
                            {_t(
                                "If you don't specify an email address, you won't be able to reset your password. " +
                                    'Are you sure?'
                            )}
                        </div>
                    ),
                    button: _t('Continue'),
                    onFinished: function(confirmed) {
                        if (confirmed) {
                            self._doSubmit(ev);
                        }
                    }
                }
            );
        } else {
            self._doSubmit(ev);
        }
    },

    _doSubmit: function(ev) {
        const email = this.state.email.trim();
        const promise = this.props.onRegisterClick({
            username: this.state.username.trim(),
            password: this.state.password.trim(),
            email: email,
            phoneCountry: '',
            phoneNumber: ''
        });

        if (promise) {
            ev.target.disabled = true;
            promise.finally(function() {
                ev.target.disabled = false;
            });
        }
    },

    async verifyFieldsBeforeSubmit() {
        // Blur the active element if any, so we first run its blur validation,
        // which is less strict than the pass we're about to do below for all fields.
        const activeElement = document.activeElement;
        if (activeElement) {
            activeElement.blur();
        }

        const fieldIDsInDisplayOrder = [
            FIELD_USERNAME,
            FIELD_PASSWORD,
            FIELD_PASSWORD_CONFIRM,
            FIELD_EMAIL
        ];

        // Run all fields with stricter validation that no longer allows empty
        // values for required fields.
        for (const fieldID of fieldIDsInDisplayOrder) {
            const field = this[fieldID];
            if (!field) {
                continue;
            }
            // We must wait for these validations to finish before queueing
            // up the setState below so our setState goes in the queue after
            // all the setStates from these validate calls (that's how we
            // know they've finished).
            await field.validate({ allowEmpty: false });
        }

        // Validation and state updates are async, so we need to wait for them to complete
        // first. Queue a `setState` callback and wait for it to resolve.
        await new Promise(resolve => this.setState({}, resolve));

        if (this.allFieldsValid()) {
            return true;
        }

        const invalidField = this.findFirstInvalidField(fieldIDsInDisplayOrder);

        if (!invalidField) {
            return true;
        }

        // Focus the first invalid field and show feedback in the stricter mode
        // that no longer allows empty values for required fields.
        invalidField.focus();
        invalidField.validate({ allowEmpty: false, focused: true });
        return false;
    },

    /**
     * @returns {boolean} true if all fields were valid last time they were validated.
     */
    allFieldsValid: function() {
        const keys = Object.keys(this.state.fieldValid);
        for (let i = 0; i < keys.length; ++i) {
            if (!this.state.fieldValid[keys[i]]) {
                return false;
            }
        }
        return true;
    },

    findFirstInvalidField(fieldIDs) {
        for (const fieldID of fieldIDs) {
            if (!this.state.fieldValid[fieldID] && this[fieldID]) {
                return this[fieldID];
            }
        }
        return null;
    },

    markFieldValid: function(fieldID, valid) {
        const { fieldValid } = this.state;
        fieldValid[fieldID] = valid;
        this.setState({
            fieldValid
        });
    },

    onEmailChange(ev) {
        this.setState({
            email: ev.target.value
        });
    },

    async onEmailValidate(fieldState) {
        const result = await this.validateEmailRules(fieldState);
        this.markFieldValid(FIELD_EMAIL, result.valid);
        return result;
    },

    validateEmailRules: withValidation({
        description: () => _t('Use an email address to recover your account'),
        rules: [
            {
                key: 'required',
                test: function({ value, allowEmpty }) {
                    return (
                        allowEmpty ||
                        !this._authStepIsRequired('m.login.email.identity') ||
                        !!value
                    );
                },
                invalid: () =>
                    _t('Enter email address (required on this homeserver)')
            },
            {
                key: 'email',
                test: ({ value }) => !value || Email.looksValid(value),
                invalid: () => _t("Doesn't look like a valid email address")
            }
        ]
    }),

    onPasswordChange(ev) {
        this.setState({
            password: ev.target.value
        });
    },

    async onPasswordValidate(fieldState) {
        const result = await this.validatePasswordRules(fieldState);
        this.markFieldValid(FIELD_PASSWORD, result.valid);
        return result;
    },

    validatePasswordRules: withValidation({
        description: function() {
            const complexity = this.state.passwordComplexity;
            const score = complexity ? complexity.score : 0;
            return (
                <progress
                    className='mx_AuthBody_passwordScore'
                    max={PASSWORD_MIN_SCORE}
                    value={score}
                />
            );
        },
        rules: [
            {
                key: 'required',
                test: ({ value, allowEmpty }) => allowEmpty || !!value,
                invalid: () => _t('Enter password')
            },
            {
                key: 'complexity',
                test: async function({ value }) {
                    if (!value) {
                        return false;
                    }
                    const { scorePassword } = await import(
                        '../../../utils/PasswordScorer'
                    );
                    const complexity = scorePassword(value);
                    const safe = complexity.score >= PASSWORD_MIN_SCORE;
                    const allowUnsafe = SdkConfig.get()[
                        'dangerously_allow_unsafe_and_insecure_passwords'
                    ];
                    this.setState({
                        passwordComplexity: complexity,
                        passwordSafe: safe
                    });
                    return allowUnsafe || safe;
                },
                valid: function() {
                    // Unsafe passwords that are valid are only possible through a
                    // configuration flag. We'll print some helper text to signal
                    // to the user that their password is allowed, but unsafe.
                    if (!this.state.passwordSafe) {
                        return _t('Password is allowed, but unsafe');
                    }
                    return _t('Nice, strong password!');
                },
                invalid: function() {
                    const complexity = this.state.passwordComplexity;
                    if (!complexity) {
                        return null;
                    }
                    const { feedback } = complexity;
                    return (
                        feedback.warning ||
                        feedback.suggestions[0] ||
                        _t('Keep going...')
                    );
                }
            }
        ]
    }),

    onPasswordConfirmChange(ev) {
        this.setState({
            passwordConfirm: ev.target.value
        });
    },

    async onPasswordConfirmValidate(fieldState) {
        const result = await this.validatePasswordConfirmRules(fieldState);
        this.markFieldValid(FIELD_PASSWORD_CONFIRM, result.valid);
        return result;
    },

    validatePasswordConfirmRules: withValidation({
        rules: [
            {
                key: 'required',
                test: ({ value, allowEmpty }) => allowEmpty || !!value,
                invalid: () => _t('Confirm password')
            },
            {
                key: 'match',
                test: function({ value }) {
                    return !value || value === this.state.password;
                },
                invalid: () => _t("Passwords don't match")
            }
        ]
    }),

    onUsernameChange(ev) {
        this.setState({
            username: ev.target.value
        });
    },

    async onUsernameValidate(fieldState) {
        const result = await this.validateUsernameRules(fieldState);
        this.markFieldValid(FIELD_USERNAME, result.valid);
        return result;
    },

    validateUsernameRules: withValidation({
        description: () =>
            _t('Use lowercase letters, numbers, dashes and underscores only'),
        rules: [
            {
                key: 'required',
                test: ({ value, allowEmpty }) => allowEmpty || !!value,
                invalid: () => _t('Enter username')
            },
            {
                key: 'safeLocalpart',
                test: ({ value }) => !value || SAFE_LOCALPART_REGEX.test(value),
                invalid: () => _t('Some characters not allowed')
            }
        ]
    }),

    /**
     * A step is required if all flows include that step.
     *
     * @param {string} step A stage name to check
     * @returns {boolean} Whether it is required
     */
    _authStepIsRequired(step) {
        return this.props.flows.every(flow => {
            return flow.stages.includes(step);
        });
    },

    /**
     * A step is used if any flows include that step.
     *
     * @param {string} step A stage name to check
     * @returns {boolean} Whether it is used
     */
    _authStepIsUsed(step) {
        return this.props.flows.some(flow => {
            return flow.stages.includes(step);
        });
    },

    renderEmail() {
        if (!this._authStepIsUsed('m.login.email.identity')) {
            return null;
        }
        const Field = sdk.getComponent('elements.Field');
        const emailPlaceholder = this._authStepIsRequired(
            'm.login.email.identity'
        )
            ? _t('Email')
            : _t('Email (optional)');
        return (
            <Field
                id='mx_RegistrationForm_email'
                ref={field => (this[FIELD_EMAIL] = field)}
                type='text'
                label={emailPlaceholder}
                defaultValue={this.props.defaultEmail}
                value={this.state.email}
                onChange={this.onEmailChange}
                onValidate={this.onEmailValidate}
            />
        );
    },

    renderPassword() {
        const Field = sdk.getComponent('elements.Field');
        return (
            <Field
                id='mx_RegistrationForm_password'
                ref={field => (this[FIELD_PASSWORD] = field)}
                type='password'
                label={_t('New Password')}
                defaultValue={this.props.defaultPassword}
                value={this.state.password}
                onChange={this.onPasswordChange}
                onValidate={this.onPasswordValidate}
            />
        );
    },

    renderPasswordConfirm() {
        const Field = sdk.getComponent('elements.Field');
        return (
            <Field
                id='mx_RegistrationForm_passwordConfirm'
                ref={field => (this[FIELD_PASSWORD_CONFIRM] = field)}
                type='password'
                label={_t('Confirm')}
                defaultValue={this.props.defaultPassword}
                value={this.state.passwordConfirm}
                onChange={this.onPasswordConfirmChange}
                onValidate={this.onPasswordConfirmValidate}
            />
        );
    },

    renderUsername() {
        const Field = sdk.getComponent('elements.Field');
        return (
            <Field
                id='mx_RegistrationForm_username'
                ref={field => (this[FIELD_USERNAME] = field)}
                type='text'
                autoFocus={true}
                label={_t('Username')}
                defaultValue={this.props.defaultUsername}
                value={this.state.username}
                onChange={this.onUsernameChange}
                onValidate={this.onUsernameValidate}
            />
        );
    },

    render: function() {
        let yourMatrixAccountText = _t(
            'Create your Matrix account on %(serverName)s',
            {
                serverName: this.props.serverConfig.hsName
            }
        );
        if (this.props.serverConfig.hsNameIsDifferent) {
            const TextWithTooltip = sdk.getComponent(
                'elements.TextWithTooltip'
            );

            yourMatrixAccountText = _t(
                'Create your Matrix account on <underlinedServerName />',
                {},
                {
                    underlinedServerName: () => {
                        return (
                            <TextWithTooltip
                                class='mx_Login_underlinedServerName'
                                tooltip={this.props.serverConfig.hsUrl}
                            >
                                {this.props.serverConfig.hsName}
                            </TextWithTooltip>
                        );
                    }
                }
            );
        }

        let editLink = null;
        if (this.props.onEditServerDetailsClick) {
            editLink = (
                <a
                    className='mx_AuthBody_editServerDetails'
                    href='#'
                    onClick={this.props.onEditServerDetailsClick}
                >
                    {_t('Change')}
                </a>
            );
        }

        const registerButton = (
            <input
                className='mx_Login_submit'
                type='submit'
                value={_t('Register')}
                disabled={!this.props.canSubmit}
            />
        );

        return (
            <div>
                <form onSubmit={this.onSubmit}>
                    <div className='mx_AuthBody_fieldRow'>
                        {this.renderUsername()}
                    </div>
                    <div className='mx_AuthBody_fieldRow'>
                        {this.renderPassword()}
                        {this.renderPasswordConfirm()}
                    </div>
                    <div className='mx_AuthBody_fieldRow'>
                        {this.renderEmail()}
                    </div>
                    {_t('Use an email address to recover your account.') + ' '}
                    {_t(
                        'Other users can invite you to rooms using your contact details.'
                    )}
                    {registerButton}
                </form>
            </div>
        );
    }
});
