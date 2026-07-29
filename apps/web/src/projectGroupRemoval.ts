export async function removeProjectGroupMembersSequentially<Member>(
  members: ReadonlyArray<Member>,
  removeMember: (member: Member) => Promise<void>,
  onMemberRemoved: (member: Member) => void,
): Promise<void> {
  for (const member of members) {
    await removeMember(member);
    onMemberRemoved(member);
  }
}
