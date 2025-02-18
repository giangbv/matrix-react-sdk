//@flow
/*
Copyright 2016 Aviral Dasgupta
Copyright 2017 Vector Creations Ltd
Copyright 2017, 2018 New Vector Ltd
Copyright 2018 Michael Telatynski <7t3chguy@gmail.com>

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
import { _t } from '../languageHandler';
import AutocompleteProvider from './AutocompleteProvider';
import { PillCompletion } from './Components';
import sdk from '../index';
import QueryMatcher from './QueryMatcher';
import _sortBy from 'lodash/sortBy';
import MatrixClientPeg from '../MatrixClientPeg';

import type { MatrixEvent, Room, RoomMember, RoomState } from 'matrix-js-sdk';
import { makeUserPermalink } from '../matrix-to';
import type { Completion, SelectionRange } from './Autocompleter';

const USER_REGEX = /\B@\S*/g;

// used when you hit 'tab' - we allow some separator chars at the beginning
// to allow you to tab-complete /mat into /(matthew)
const FORCED_USER_REGEX = /[^/,:; \t\n]\S*/g;

export default class UserProvider extends AutocompleteProvider {
    users: Array<RoomMember> = null;
    room: Room = null;

    constructor(room: Room) {
        super(USER_REGEX, FORCED_USER_REGEX);
        this.room = room;
        this.matcher = new QueryMatcher([], {
            keys: ['name'],
            funcs: [obj => obj.userId.slice(1)], // index by user id minus the leading '@'
            shouldMatchPrefix: true,
            shouldMatchWordsOnly: false
        });

        this._onRoomTimelineBound = this._onRoomTimeline.bind(this);
        this._onRoomStateMemberBound = this._onRoomStateMember.bind(this);

        MatrixClientPeg.get().on('Room.timeline', this._onRoomTimelineBound);
        MatrixClientPeg.get().on(
            'RoomState.members',
            this._onRoomStateMemberBound
        );
    }

    destroy() {
        if (MatrixClientPeg.get()) {
            MatrixClientPeg.get().removeListener(
                'Room.timeline',
                this._onRoomTimelineBound
            );
            MatrixClientPeg.get().removeListener(
                'RoomState.members',
                this._onRoomStateMemberBound
            );
        }
    }

    _onRoomTimeline(
        ev: MatrixEvent,
        room: Room,
        toStartOfTimeline: boolean,
        removed: boolean,
        data: Object
    ) {
        if (!room) return;
        if (removed) return;
        if (room.roomId !== this.room.roomId) return;

        // ignore events from filtered timelines
        if (data.timeline.getTimelineSet() !== room.getUnfilteredTimelineSet())
            return;

        // ignore anything but real-time updates at the end of the room:
        // updates from pagination will happen when the paginate completes.
        if (toStartOfTimeline || !data || !data.liveEvent) return;

        // TODO: lazyload if we have no ev.sender room member?
        this.onUserSpoke(ev.sender);

        if (['m.room.message', 'm.room.encrypted'].includes(ev.getType())) {
            console.log('*****************', ev);
        }
    }

    _onRoomStateMember(ev: MatrixEvent, state: RoomState, member: RoomMember) {
        // ignore members in other rooms
        if (member.roomId !== this.room.roomId) {
            return;
        }

        // blow away the users cache
        this.users = null;
    }

    async getCompletions(
        query: string,
        selection: SelectionRange,
        force?: boolean = false
    ): Array<Completion> {
        const MemberAvatar = sdk.getComponent('views.avatars.MemberAvatar');

        // lazy-load user list into matcher
        if (this.users === null) this._makeUsers();

        let completions = [];
        const { command, range } = this.getCurrentCommand(
            query,
            selection,
            force
        );

        if (!command) return completions;

        const fullMatch = command[0];
        // Don't search if the query is a single "@"
        if (fullMatch && fullMatch !== '@') {
            // Don't include the '@' in our search query - it's only used as a way to trigger completion
            const query = fullMatch.startsWith('@')
                ? fullMatch.substring(1)
                : fullMatch;
            completions = this.matcher.match(query).map(user => {
                const displayName = user.name || user.userId || '';
                return {
                    // Length of completion should equal length of text in decorator. draft-js
                    // relies on the length of the entity === length of the text in the decoration.
                    completion: user.rawDisplayName,
                    completionId: user.userId,
                    suffix:
                        selection.beginning && range.start === 0 ? ': ' : ' ',
                    href: makeUserPermalink(user.userId),
                    component: (
                        <PillCompletion
                            initialComponent={
                                <MemberAvatar
                                    member={user}
                                    width={24}
                                    height={24}
                                />
                            }
                            title={displayName}
                            description={user.userId}
                        />
                    ),
                    range
                };
            });
        }
        return completions;
    }

    getName(): string {
        return '👥 ' + _t('Users');
    }

    _makeUsers() {
        const events = this.room.getLiveTimeline().getEvents();
        const lastSpoken = {};

        for (const event of events) {
            lastSpoken[event.getSender()] = event.getTs();
        }

        const currentUserId = MatrixClientPeg.get().credentials.userId;
        this.users = this.room
            .getJoinedMembers()
            .filter(({ userId }) => userId !== currentUserId);

        this.users = _sortBy(
            this.users,
            member => 1e20 - lastSpoken[member.userId] || 1e20
        );

        this.matcher.setObjects(this.users);
    }

    onUserSpoke(user: RoomMember) {
        if (this.users === null) return;
        if (!user) return;
        if (user.userId === MatrixClientPeg.get().credentials.userId) return;

        // Move the user that spoke to the front of the array
        this.users.splice(
            this.users.findIndex(user2 => user2.userId === user.userId),
            1
        );
        this.users = [user, ...this.users];

        this.matcher.setObjects(this.users);
    }

    renderCompletions(completions: [React.Component]): ?React.Component {
        return (
            <div className='mx_Autocomplete_Completion_container_pill'>
                {completions}
            </div>
        );
    }

    shouldForceComplete(): boolean {
        return true;
    }
}
