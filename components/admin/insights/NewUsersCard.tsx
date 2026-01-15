"use client";

import { UsersIcon } from "lucide-react";
import  DocumentCountCard from "./DocumentCountCard";

const NewUsersCard = () => {
  return (
    <DocumentCountCard
      documentType="user"
      title="Total Users"
      icon={UsersIcon}
    />
  );
};

export default NewUsersCard;
